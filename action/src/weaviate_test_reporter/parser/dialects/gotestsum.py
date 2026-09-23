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
_GO_TIMEOUT_PREFIX = "panic: test timed out after "
# Lines under "running tests:" in a timeout panic: `\t\tTestX/sub (1m12s)`.
# Go replaces spaces in subtest names with underscores, so \S+ is the name.
_GO_RUNNING_TEST_RE = re.compile(r"^\t\t(\S+) \([^)]*\)\s*$", re.MULTILINE)
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


def _postprocess(cases: list[ParsedCase]) -> list[ParsedCase]:
    """Make gotestsum cases match what a reader means by "a failing test":

    1. Replace the `Failed` placeholder message with the real reason.
    2. Drop failed parents that have a failing subtest: Go fails the parent
       whenever a subtest fails, so keeping both double-counts one failure.
       Trade-off: a parent's own assertion, reported alongside a failing
       subtest, is not stored separately.
    3. Package timeout: go test reports it as a synthetic `TestMain` case
       holding the panic, while the tests that were running get only their
       own log lines. Copy the panic onto every kept failure that is listed as
       running or is a subtest of a listed test, then drop `TestMain`. It is
       kept when no such failure exists, and whenever TestMain failed for
       another reason (e.g. cluster setup), since it is then the only record.
    """
    out: list[ParsedCase] = []
    for c in cases:
        if c.status == "failed" and (c.error_message or "") in _GO_PLACEHOLDER_MESSAGES:
            c = replace(
                c, error_message=_truncate(_go_failure_message(c.stack_trace)) or c.error_message
            )
        out.append(c)

    failing_ancestors: set[str] = set()
    for c in out:
        if c.status == "failed":
            parts = c.name.split("/")
            failing_ancestors.update("/".join(parts[:i]) for i in range(1, len(parts)))
    out = [c for c in out if not (c.status == "failed" and c.name in failing_ancestors)]

    main = next((c for c in out if c.name == "TestMain" and c.status == "failed"), None)
    panic_body = (main.stack_trace or "") if main is not None else ""
    if main is None or not panic_body.lstrip().startswith(_GO_TIMEOUT_PREFIX):
        return out
    running = set(_GO_RUNNING_TEST_RE.findall(panic_body))

    def was_running(name: str) -> bool:
        parts = name.split("/")
        return any("/".join(parts[:i]) in running for i in range(1, len(parts) + 1))

    enriched: list[ParsedCase] = []
    victims = 0
    for c in out:
        if c is not main and c.status == "failed" and was_running(c.name):
            stack = _truncate(f"{panic_body}\n\n--- test output ---\n{c.stack_trace or ''}")
            c = replace(
                c,
                error_message=main.error_message,
                stack_trace=stack,
                failure_fingerprint=stack_trace_fingerprint(stack),
            )
            victims += 1
        enriched.append(c)
    return [c for c in enriched if c is not main] if victims else enriched


DIALECT = Dialect(framework="golang", matches=_matches, postprocess=_postprocess)
