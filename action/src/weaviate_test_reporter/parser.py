"""JUnit XML -> ParsedCase dataclasses.

Handles pytest, gotestsum, jest, and surefire dialects via junitparser, which
wraps lxml under the hood. Designed to be a pure-function streaming iterator
so callers can keep memory bounded on large CI reports.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from junitparser import Error, Failure, JUnitXml, Skipped, TestSuite
from junitparser import TestCase as JUnitTestCase
from junitparser.xunit2 import FlakyError, FlakyFailure, RerunError, RerunFailure

MAX_TEXT_BYTES = 32_768
TRUNC_MARKER = "\n[... truncated]"

# Surefire (and gotestsum via the surefire-compatible writer) records retries
# as extra child elements on a <testcase>. junitparser exposes their classes
# in the xunit2 flavor; the base parser we use for streaming still lets us
# locate them with `case.iterchildren(<cls>)`. A test that ultimately PASSED
# keeps its failed attempts as <flakyFailure>/<flakyError>; a test that stayed
# red keeps intermediate reruns as <rerunFailure>/<rerunError> alongside the
# final <failure>/<error>. We count all four the same way — the number of
# retry elements — and derive the flake signal from the FINAL status.
_RERUN_ELEMENT_TYPES = (RerunFailure, RerunError, FlakyFailure, FlakyError)

_FINGERPRINT_LEN = 16


@dataclass
class ParsedCase:
    name: str
    test_suite: str
    framework: str
    status: str
    duration_ms: int
    error_message: str | None
    stack_trace: str | None
    failure_type: str | None
    # WS1 D3 (retry / rerun capture) — populated per case; dialects without
    # rerun elements degrade to 0 / False / status.
    retry_count: int = 0
    passed_on_retry: bool = False
    initial_status: str = "passed"
    # WS1 D4 (stack-trace fingerprint) — set only for failed cases.
    failure_fingerprint: str | None = None


@dataclass
class RunSummary:
    """Run-level aggregates lifted from the <testsuite> elements themselves.

    Distinct from the per-case stream: `started_at` is the earliest suite
    `timestamp` (WS1 D1) and the `tests_*` counts come from the suite summary
    attributes (WS1 D2). junitparser recomputes the counts from child cases
    when a dialect omits the attributes, so they are always populated.
    """

    started_at: datetime | None = None
    tests_total: int = 0
    tests_failed: int = 0
    tests_errors: int = 0
    tests_skipped: int = 0


def _truncate(text: str | None) -> str | None:
    if text is None:
        return None
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_TEXT_BYTES:
        return text
    budget = MAX_TEXT_BYTES - len(TRUNC_MARKER.encode("utf-8"))
    return encoded[:budget].decode("utf-8", errors="ignore") + TRUNC_MARKER


def _classify(case: JUnitTestCase) -> tuple[str, str | None, str | None, str | None]:
    for result in case.result:
        if isinstance(result, (Failure, Error)):
            # Preserve the XML's type attribute verbatim. Don't invent a class
            # name from the Python wrapper — many dialects (jest-junit,
            # gotestsum) emit <failure> with no type or an empty type, and
            # downstream filters should see that as "unspecified".
            ftype = result.type if result.type else None
            return (
                "failed",
                _truncate(result.message or ""),
                _truncate(result.text or ""),
                ftype,
            )
        if isinstance(result, Skipped):
            return "skipped", _truncate(result.message or ""), None, None
    return "passed", None, None, None


# WS1 D4: stack-trace fingerprint.
#
# We hash a NORMALIZED trace so that two failures that differ only in volatile
# tokens (line numbers, memory addresses, timestamps, temp paths, long id
# runs) collapse to the same key — the exact-match dedup used by R4 — while
# genuinely different error shapes (types, messages, file names) stay distinct.
# Order matters: strip whole ISO timestamps and temp-path tokens BEFORE the
# generic `:<line>` / long-digit passes so their internal digits aren't
# rewritten piecemeal.
_ISO_TIMESTAMP_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"
)
# Volatile filesystem roots: OS temp dirs plus CI runner work dirs (GitHub
# hosted `/home/runner/work/…`, self-hosted `/home/actions-runner/_work/…`,
# and the legacy `/runner/_work/…`). Stripping these lets the same failure
# fingerprint identically across runner types.
_TEMP_PATH_RE = re.compile(
    r"(?:/tmp/|/var/folders/|/private/"
    r"|/home/runner/work/|/home/actions-runner/_work/|/runner/_work/)\S*"
)
# Go/gotestsum elapsed-time suffix, e.g. `(0.08s)`, `(200ms)`, `(3µs)`. The
# duration varies run-to-run and must not fragment the fingerprint. Stripped
# BEFORE the long-digit pass so millisecond/nanosecond magnitudes collapse too.
_GO_DURATION_RE = re.compile(r"\(\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h)\)")
_HEX_ADDR_RE = re.compile(r"0x[0-9a-fA-F]+")
_LINE_WORD_RE = re.compile(r"\bline\s+\d+", re.IGNORECASE)
_COLON_LINE_RE = re.compile(r":\d+")
_LONG_DIGITS_RE = re.compile(r"\d{4,}")
_WS_RE = re.compile(r"\s+")


def normalize_stack_trace(text: str) -> str:
    """Strip volatile tokens from a stack trace so equivalent failures hash
    identically. Pure function — unit-tested directly."""
    s = _ISO_TIMESTAMP_RE.sub("<TS>", text)
    s = _TEMP_PATH_RE.sub("<PATH>", s)
    s = _GO_DURATION_RE.sub("(<DUR>)", s)
    s = _HEX_ADDR_RE.sub("<HEX>", s)
    s = _LINE_WORD_RE.sub("line <N>", s)
    s = _COLON_LINE_RE.sub(":<N>", s)
    s = _LONG_DIGITS_RE.sub("<NUM>", s)
    return _WS_RE.sub(" ", s).strip()


def stack_trace_fingerprint(text: str | None) -> str | None:
    """Stable 16-char sha256 of the normalized trace; None for empty input."""
    if text is None or not text.strip():
        return None
    normalized = normalize_stack_trace(text)
    digest = hashlib.sha256(normalized.encode("utf-8", errors="replace")).hexdigest()
    return digest[:_FINGERPRINT_LEN]


def _count_reruns(case: JUnitTestCase) -> int:
    """Number of surefire rerun/flaky elements on the case. Fail-safe: any
    junitparser quirk yields 0 rather than raising."""
    try:
        return sum(1 for cls in _RERUN_ELEMENT_TYPES for _ in case.iterchildren(cls))
    except Exception:
        return 0


def _detect_framework(case: JUnitTestCase) -> str:
    """Best-effort framework detection from the case's classname/name.

    Note: `classname.startswith("github.com/")` is a deliberately loose
    heuristic for gotestsum — a Java classname like
    `com.github.foo.Bar` would NOT match (no leading slash and starts
    with `com.`, not `github.com`). False positives are theoretically
    possible if a Java package literally starts with `github.com.` but
    no such convention exists in practice.
    """
    classname = (case.classname or "").lower()
    name = (case.name or "").lower()
    if classname.startswith("github.com/") or "_test.go" in classname:
        return "golang"
    if "::" in name or name.startswith("test_") or classname.startswith("tests."):
        return "pytest"
    return "unknown"


def parse_junit_file(path: Path) -> Iterator[ParsedCase]:
    """Yield a ParsedCase per <testcase> element.

    Handles two XML root shapes:

    - `<testsuites>` wrapping multiple `<testsuite>` blocks — junitparser
      returns a `JUnitXml` object whose iteration yields TestSuite instances.
    - A bare `<testsuite>` root (Maven surefire) — junitparser returns a
      `TestSuite` directly; iterating it yields TestCase instances, not
      TestSuite. We detect this with isinstance and wrap accordingly.

    Inside each suite, we also skip non-TestCase children (`<system-out>`,
    `<system-err>`, `<properties>`) which some junitparser versions yield
    as part of TestSuite iteration.
    """
    xml = JUnitXml.fromfile(str(path))
    if isinstance(xml, TestSuite):
        iter_suites: Iterator[TestSuite] = iter([xml])
    else:
        iter_suites = iter(xml)

    for suite in iter_suites:
        fallback_suite_name = suite.name or "unknown"
        for case in suite:
            # Defensive: some junitparser versions yield non-TestCase
            # children of a TestSuite (system-out / properties / etc.).
            if not isinstance(case, JUnitTestCase):
                continue
            status, msg, stack, ftype = _classify(case)
            retry_count = _count_reruns(case)
            if retry_count > 0:
                # Reruns only appear when the first attempt failed; the flake
                # signal is whether the FINAL status recovered to passed.
                initial_status = "failed"
                passed_on_retry = status == "passed"
            else:
                initial_status = status
                passed_on_retry = False
            fingerprint = stack_trace_fingerprint(stack or msg) if status == "failed" else None
            yield ParsedCase(
                name=case.name or "unknown",
                test_suite=_pick_test_suite(case, fallback_suite_name),
                framework=_detect_framework(case),
                status=status,
                duration_ms=int(round((case.time or 0) * 1000)),
                error_message=msg,
                stack_trace=stack,
                failure_type=ftype,
                retry_count=retry_count,
                passed_on_retry=passed_on_retry,
                initial_status=initial_status,
                failure_fingerprint=fingerprint,
            )


def _pick_test_suite(case: JUnitTestCase, fallback: str) -> str:
    """Choose the most useful `test_suite` value for the case.

    Different producers organize JUnit output differently:

    - pytest-junit wraps EVERYTHING in a single <testsuite name="pytest">,
      and disambiguates per-case via `classname` (e.g.,
      `tests.e2e.core.collection_alias_test`). Falling back to suite.name
      would collapse every TestCase to "pytest" — useless for grouping.
    - gotestsum / surefire use a meaningful suite.name (the Go package
      or the Java class), and classname duplicates it.
    - jest-junit uses suite.name for the outer describe and classname
      for the FULL test path (often == case.name). Using classname there
      makes every test its own "suite".

    Heuristic: prefer `classname` when it's both present and meaningfully
    distinct from `case.name`. Otherwise fall back to the suite name.
    """
    classname = (case.classname or "").strip()
    name = (case.name or "").strip()
    if classname and classname != name:
        return classname
    return fallback


# ---------------------------------------------------------------------------
# WS1 D1 + D2: run-level summary (started_at + counts)
# ---------------------------------------------------------------------------


def _parse_timestamp(raw: str | None) -> datetime | None:
    """Parse a `<testsuite timestamp>` (RFC3339 / ISO 8601) into a
    timezone-aware datetime. Naive timestamps are assumed UTC so the Weaviate
    DATE column is always tz-aware. Fail-safe: unparseable input -> None."""
    if not raw:
        return None
    s = raw.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def _safe_int(value: object) -> int:
    """Coerce a junitparser count attribute to int; None / garbage -> 0."""
    if value is None:
        return 0
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def parse_junit_summary(path: Path) -> RunSummary:
    """Parse a JUnit file for its RUN-level aggregates only.

    Separate from `parse_junit_file` (which streams per-case) because these
    live on the <testsuite> elements: `started_at` is the earliest suite
    `timestamp`; the counts are the summed suite summary attributes. This does
    a second lightweight lxml pass — cheap next to the per-case object build.

    Fail-safe: a malformed file yields an empty RunSummary rather than raising,
    so the action never breaks a user's CI.
    """
    try:
        xml = JUnitXml.fromfile(str(path))
        suites: Iterable[TestSuite] = [xml] if isinstance(xml, TestSuite) else list(xml)
    except Exception:
        return RunSummary()

    earliest: datetime | None = None
    total = failed = errors = skipped = 0
    for suite in suites:
        ts = _parse_timestamp(getattr(suite, "timestamp", None))
        if ts is not None and (earliest is None or ts < earliest):
            earliest = ts
        # junitparser returns the XML attribute when present, else recomputes
        # from child cases — so these are populated even for dialects that omit
        # the summary attributes (WS1 D2 fallback happens for free here).
        total += _safe_int(suite.tests)
        failed += _safe_int(suite.failures)
        errors += _safe_int(suite.errors)
        skipped += _safe_int(suite.skipped)

    return RunSummary(
        started_at=earliest,
        tests_total=total,
        tests_failed=failed,
        tests_errors=errors,
        tests_skipped=skipped,
    )


def merge_summaries(summaries: Iterable[RunSummary]) -> RunSummary:
    """Combine per-file summaries into one run-level summary: earliest
    `started_at` across files, summed counts."""
    earliest: datetime | None = None
    total = failed = errors = skipped = 0
    for s in summaries:
        if s.started_at is not None and (earliest is None or s.started_at < earliest):
            earliest = s.started_at
        total += s.tests_total
        failed += s.tests_failed
        errors += s.tests_errors
        skipped += s.tests_skipped
    return RunSummary(
        started_at=earliest,
        tests_total=total,
        tests_failed=failed,
        tests_errors=errors,
        tests_skipped=skipped,
    )
