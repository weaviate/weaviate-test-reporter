"""gotestsum (Go) dialect.

gotestsum's JUnit output differs from what a reader expects in four ways,
all seen in weaviate/weaviate CI output (fixtures: tests/unit/fixtures/gotestsum_*):
every failure has message="Failed"; a failing subtest also fails its parent;
a package timeout is reported on a synthetic `TestMain` case; nested Go
modules have import paths without a `github.com/` prefix.
"""

from __future__ import annotations

import re
from dataclasses import replace

from junitparser import TestSuite

from ..fingerprint import stack_trace_fingerprint
from ..models import ParsedCase, _truncate
from .base import Dialect

# gotestsum writes `message="Failed"` on every <failure>; the reason is only in
# the body (the test's own output).
_GO_PLACEHOLDER_MESSAGES = frozenset({"", "Failed"})
_GO_PANIC_RE = re.compile(r"^\s*(panic: .+?)\s*$", re.MULTILINE)
# Written by Go's `testing` package when -timeout expires, identical for every
# Go module:
#   panic: test timed out after <d>
#   \trunning tests:              (Go >= 1.20; older versions omit the list)
#   \t\t<TestName> (<elapsed>)
# Go replaces spaces in subtest names with underscores, so \S+ is the name.
_GO_TIMEOUT_RE = re.compile(r"^panic: test timed out after .*$", re.MULTILINE)
_GO_RUNNING_HEADER = "\trunning tests:"
_GO_RUNNING_TEST_RE = re.compile(r"^\t\t(\S+) \([^)]*\)\s*$")
# Parts of a Go goroutine dump that change between runs of the same failure.
_GO_GOROUTINE_ID_RE = re.compile(r"\bgoroutine \d+\b")
_GO_WAIT_MINUTES_RE = re.compile(r", \d+ minutes")
_GO_GOROUTINE_HEADER_RE = re.compile(r"^goroutine \d+ \[", re.MULTILINE)
# testify output: a key line `<indent>\tError:      \t<value>` followed by
# continuation lines `<indent>\t            \t<value>`.
_TESTIFY_KEY_RE = re.compile(r"^\s+\t(Error Trace|Error|Test|Messages):\s*(.*)$")
_TESTIFY_CONT_RE = re.compile(r"^\s+\t\s+\t(.*)$")
_GO_FRAMING_RE = re.compile(
    r"^\s*(?:=== (?:RUN|PAUSE|CONT|NAME)\b|--- (?:PASS|FAIL|SKIP):"
    r"|FAIL\b|ok\s|PASS$|exit status \d+$)"
)


def _matches(suite: TestSuite) -> bool:
    """gotestsum writes a `go.version` property on every suite. More reliable
    than the classname heuristic: nested Go modules (e.g. weaviate's
    `acceptance_tests_with_client`) have no `github.com/` prefix."""
    try:
        props = suite.properties()
        return props is not None and any(p.name == "go.version" for p in props)
    except Exception:
        return False


_WS_RE = re.compile(r"\s+")


def _collapse_ws(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def _testify_message(body: str) -> str | None:
    """First testify assertion in the body as `<Error> — <Messages>`."""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        key = _TESTIFY_KEY_RE.match(line)
        if key is None or key.group(1) != "Error":
            continue
        sections: dict[str, list[str]] = {"Error": [key.group(2)]}
        current = "Error"
        for nxt in lines[i + 1 :]:
            k = _TESTIFY_KEY_RE.match(nxt)
            if k is not None:
                if k.group(1) in ("Error", "Error Trace"):
                    break  # next assertion
                current = k.group(1)
                sections.setdefault(current, []).append(k.group(2))
                continue
            cont = _TESTIFY_CONT_RE.match(nxt)
            if cont is None:
                break
            sections.setdefault(current, []).append(cont.group(1))
        error = _collapse_ws(" ".join(sections["Error"]))
        messages = _collapse_ws(" ".join(sections.get("Messages", [])))
        return f"{error} — {messages}" if messages else error
    return None


def _go_failure_message(body: str | None) -> str | None:
    """Human-readable reason for a Go failure: the panic line, else the first
    testify assertion, else the last line of the test's own output."""
    if not body:
        return None
    panic = _GO_PANIC_RE.search(body)
    if panic is not None:
        return panic.group(1)
    testify = _testify_message(body)
    if testify:
        return testify
    for line in reversed(body.splitlines()):
        if line.strip() and not _GO_FRAMING_RE.match(line):
            return line.strip()
    return None


def _panic_signature(body: str | None) -> str | None:
    """The stable identity of a Go panic: from the first `panic:` line to the
    end of the first goroutine block (the goroutine that panicked), with
    goroutine ids and wait durations removed. Setup logs before the panic,
    the other goroutines and the trailing `FAIL <pkg> <elapsed>` line all
    change between runs and are left out. None when the body has no panic."""
    if not body:
        return None
    panic = _GO_PANIC_RE.search(body)
    if panic is None:
        return None
    rest = body[panic.start(1) :]
    header = _GO_GOROUTINE_HEADER_RE.search(rest)
    end = rest.find("\n\n", header.start() if header is not None else 0)
    signature = rest if end == -1 else rest[:end]
    signature = _GO_GOROUTINE_ID_RE.sub("goroutine <N>", signature)
    return _GO_WAIT_MINUTES_RE.sub("", signature)


def _running_tests(package_output: str) -> set[str] | None:
    """Names under `running tests:` of Go's timeout panic, wherever that panic
    sits in the package output. None when the output has no timeout panic."""
    timeout = _GO_TIMEOUT_RE.search(package_output)
    if timeout is None:
        return None
    names: set[str] = set()
    for line in package_output[timeout.end() :].splitlines()[1:]:
        if line.rstrip() == _GO_RUNNING_HEADER:
            continue
        m = _GO_RUNNING_TEST_RE.match(line)
        if m is None:
            break
        names.add(m.group(1))
    return names


def _postprocess(cases: list[ParsedCase]) -> list[ParsedCase]:
    """Make gotestsum cases match what a reader means by "a failing test":

    1. Replace the `Failed` placeholder message with the real reason.
    2. Drop failed parents that have a failing subtest: Go fails the parent
       whenever a subtest fails, so keeping both double-counts one failure.
       Trade-off: a parent's own assertion, reported alongside a failing
       subtest, is not stored separately.
    3. Package timeout. gotestsum records everything a failed package printed
       outside any test as a case named `TestMain`, whether or not the package
       defines a TestMain function (Go does not allow a regular test with that
       name). On a timeout that output holds Go's timeout panic, possibly after
       setup logs, while the tests that were running get only their own
       output. Copy the panic onto every kept failure that is listed as
       running or is a subtest of a listed test, then drop `TestMain`. It is
       kept when no such failure exists, and when the package failed for
       another reason (e.g. setup), since it is then the only record.
    4. Fingerprint a panic by its signature (`_panic_signature`), so the same
       panic hashes identically across runs.
    """
    out: list[ParsedCase] = []
    for c in cases:
        if c.status == "failed":
            if (c.error_message or "") in _GO_PLACEHOLDER_MESSAGES:
                c = replace(
                    c,
                    error_message=_truncate(_go_failure_message(c.stack_trace)) or c.error_message,
                )
            signature = _panic_signature(c.stack_trace)
            if signature is not None:
                c = replace(c, failure_fingerprint=stack_trace_fingerprint(signature))
        out.append(c)

    failing_ancestors: set[str] = set()
    for c in out:
        if c.status == "failed":
            parts = c.name.split("/")
            failing_ancestors.update("/".join(parts[:i]) for i in range(1, len(parts)))
    out = [c for c in out if not (c.status == "failed" and c.name in failing_ancestors)]

    main = next((c for c in out if c.name == "TestMain" and c.status == "failed"), None)
    package_output = (main.stack_trace or "") if main is not None else ""
    running = _running_tests(package_output) if main is not None else None
    if main is None or not running:
        return out

    def was_running(name: str) -> bool:
        parts = name.split("/")
        return any("/".join(parts[:i]) in running for i in range(1, len(parts) + 1))

    enriched: list[ParsedCase] = []
    victims = 0
    for c in out:
        if c is not main and c.status == "failed" and was_running(c.name):
            # The test's own output first: the size cap then trims the
            # goroutine dump, not the test's logs.
            stack = _truncate(
                f"{c.stack_trace or ''}\n--- package output (test timed out) ---\n"
                f"{package_output}"
            )
            c = replace(
                c,
                error_message=main.error_message,
                stack_trace=stack,
                failure_fingerprint=main.failure_fingerprint,
            )
            victims += 1
        enriched.append(c)
    return [c for c in enriched if c is not main] if victims else enriched


DIALECT = Dialect(framework="golang", matches=_matches, postprocess=_postprocess)
