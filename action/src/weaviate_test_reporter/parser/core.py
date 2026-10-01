"""Generic JUnit parsing: XML -> ParsedCase stream + run-level summary.

Parses standard JUnit via junitparser (lxml under the hood), with light
heuristics for pytest, jest-junit and surefire output. Suites from producers
that need cases rewritten or dropped (gotestsum) are handed to a module in
`dialects/`. Suites no dialect matches are streamed case by case, so memory
stays bounded on large reports; a dialect suite is built as a list first.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Iterator
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from junitparser import Error, Failure, JUnitXml, Skipped, TestSuite
from junitparser import TestCase as JUnitTestCase
from junitparser.xunit2 import FlakyError, FlakyFailure, RerunError, RerunFailure

from ..logging import get_logger
from .dialects import select_dialect
from .dialects.base import Dialect
from .fingerprint import stack_trace_fingerprint
from .models import ParsedCase, RunSummary, truncate

# Surefire (and gotestsum via the surefire-compatible writer) records retries
# as extra child elements on a <testcase>. junitparser exposes their classes
# in the xunit2 flavor; the base parser we use for streaming still lets us
# locate them with `case.iterchildren(<cls>)`. A test that ultimately PASSED
# keeps its failed attempts as <flakyFailure>/<flakyError>; a test that stayed
# red keeps intermediate reruns as <rerunFailure>/<rerunError> alongside the
# final <failure>/<error>. We count all four the same way — the number of
# retry elements — and derive the flake signal from the FINAL status.
_RERUN_ELEMENT_TYPES = (RerunFailure, RerunError, FlakyFailure, FlakyError)


def _classify(
    case: JUnitTestCase, cap: bool = True
) -> tuple[str, str | None, str | None, str | None]:
    """Status, message, body and failure type of a case. With `cap=False` the
    text is returned whole: a dialect needs the end of a long body, where Go
    prints the failure reason, and `_apply_dialect` caps it afterwards."""
    limit = truncate if cap else _uncapped
    for result in case.result:
        if isinstance(result, (Failure, Error)):
            # Preserve the XML's type attribute verbatim. Don't invent a class
            # name from the Python wrapper — many dialects (jest-junit,
            # gotestsum) emit <failure> with no type or an empty type, and
            # downstream filters should see that as "unspecified".
            ftype = result.type if result.type else None
            return (
                "failed",
                limit(result.message or ""),
                limit(result.text or ""),
                ftype,
            )
        if isinstance(result, Skipped):
            return "skipped", limit(result.message or ""), None, None
    return "passed", None, None, None


def _uncapped(text: str | None) -> str | None:
    return text


def _count_reruns(case: JUnitTestCase) -> int:
    """Number of surefire rerun/flaky elements on the case. Fail-safe: any
    junitparser quirk yields 0 rather than raising."""
    try:
        return sum(1 for cls in _RERUN_ELEMENT_TYPES for _ in case.iterchildren(cls))
    except Exception:
        return 0


def _safe_duration_ms(case: JUnitTestCase) -> int:
    """Case duration in milliseconds. junitparser exposes `time` as a FloatAttr
    that RAISES on a non-numeric value (e.g. time="oops"); left unguarded that
    would abort the whole file's case stream mid-iteration. Degrade a bad/absent
    duration to 0 for that one case instead."""
    try:
        return int(round((case.time or 0) * 1000))
    except Exception:
        return 0


def _detect_framework(case: JUnitTestCase) -> str:
    """Best-effort framework detection from the case's classname/name.

    Note: `classname.startswith("github.com/")` is a deliberately loose
    heuristic for Go output that no dialect matched (gotestsum suites carry a
    `go.version` property and use the gotestsum dialect) — a Java classname like
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
        dialect = select_dialect(suite)
        if dialect is None:
            yield from _iter_suite_cases(suite, None)
        else:
            yield from _apply_dialect(dialect, list(_iter_suite_cases(suite, dialect)))


def _iter_suite_cases(suite: TestSuite, dialect: Dialect | None) -> Iterator[ParsedCase]:
    """Generic per-case parsing of one <testsuite>. The dialect, when given,
    only sets `framework` here; its fix-ups run in `_apply_dialect`."""
    fallback_suite_name = suite.name or "unknown"
    for case in suite:
        # Defensive: some junitparser versions yield non-TestCase
        # children of a TestSuite (system-out / properties / etc.).
        if not isinstance(case, JUnitTestCase):
            continue
        status, msg, stack, ftype = _classify(case, cap=dialect is None)
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
            framework=dialect.framework if dialect is not None else _detect_framework(case),
            status=status,
            duration_ms=_safe_duration_ms(case),
            error_message=msg,
            stack_trace=stack,
            failure_type=ftype,
            retry_count=retry_count,
            passed_on_retry=passed_on_retry,
            initial_status=initial_status,
            failure_fingerprint=fingerprint,
        )


def _apply_dialect(dialect: Dialect, cases: list[ParsedCase]) -> list[ParsedCase]:
    """Run the dialect's fix-ups, then cap the text fields the dialect saw
    uncapped. Fail-safe: if the fix-ups raise, keep the generic parse of the
    suite rather than losing its results, and log why."""
    try:
        cases = dialect.postprocess(cases)
    except Exception as e:
        get_logger().warning(
            "dialect_postprocess_failed",
            framework=dialect.framework,
            error=str(e),
            error_type=type(e).__name__,
        )
    return [_capped(c) for c in cases]


def _capped(case: ParsedCase) -> ParsedCase:
    message, stack = truncate(case.error_message), truncate(case.stack_trace)
    if message is case.error_message and stack is case.stack_trace:
        return case
    return replace(case, error_message=message, stack_trace=stack)


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


def _suite_count(suite: TestSuite, attr: str) -> int:
    """Read a <testsuite> count attribute defensively. junitparser exposes these
    as IntAttr, which RAISES on a non-numeric value (e.g. tests="N/A") — before
    _safe_int can coerce it — so a single malformed attribute on one suite would
    abort the whole run's summary. Degrade just that count to 0; the other suites
    (and this suite's other counts) survive."""
    try:
        return _safe_int(getattr(suite, attr))
    except Exception:
        return 0


def parse_junit(path: Path) -> tuple[list[ParsedCase], RunSummary]:
    """`parse_junit_file` and `parse_junit_summary` in one pass: every suite is
    parsed once, so a dialect's fix-ups run once. Raises on a malformed file,
    like `parse_junit_file`; the caller decides whether to skip it."""
    xml = JUnitXml.fromfile(str(path))
    suites: Iterable[TestSuite] = [xml] if isinstance(xml, TestSuite) else list(xml)
    cases: list[ParsedCase] = []
    totals = _Totals()
    for suite in suites:
        dialect = select_dialect(suite)
        if dialect is None:
            cases.extend(_iter_suite_cases(suite, None))
            totals.add(suite, None)
        else:
            kept = _apply_dialect(dialect, list(_iter_suite_cases(suite, dialect)))
            cases.extend(kept)
            totals.add(suite, kept)
    return cases, totals.summary()


def parse_junit_summary(path: Path) -> RunSummary:
    """Parse a JUnit file for its RUN-level aggregates only.

    `started_at` is the earliest suite `timestamp`. For generic suites the
    counts are the summed <testsuite> summary attributes, read in a cheap
    second pass. For suites a dialect handles, the counts come from the kept
    cases, so this re-parses and post-processes every case of those suites;
    callers that also need the cases should use `parse_junit` instead.

    Fail-safe: a malformed file yields an empty RunSummary rather than raising,
    so the action never breaks a user's CI.
    """
    try:
        xml = JUnitXml.fromfile(str(path))
        suites: Iterable[TestSuite] = [xml] if isinstance(xml, TestSuite) else list(xml)
    except Exception:
        return RunSummary()

    totals = _Totals()
    for suite in suites:
        dialect = select_dialect(suite)
        kept = None
        if dialect is not None:
            try:
                kept = _apply_dialect(dialect, list(_iter_suite_cases(suite, dialect)))
            except Exception:
                kept = None  # fall back to the suite's own attributes
        totals.add(suite, kept)
    return totals.summary()


class _Totals:
    """Run-level counts and duration accumulated suite by suite."""

    def __init__(self) -> None:
        self.earliest: datetime | None = None
        self.total = self.failed = self.errors = self.skipped = self.duration_ms = 0

    def add(self, suite: TestSuite, kept: list[ParsedCase] | None) -> None:
        """`kept` is None for a generic suite, else the cases a dialect kept."""
        ts = _parse_timestamp(getattr(suite, "timestamp", None))
        if ts is not None and (self.earliest is None or ts < self.earliest):
            self.earliest = ts
        if kept is None:
            # junitparser returns the XML attribute when present, else
            # recomputes it from child cases (WS1 D2 fallback).
            self.total += _suite_count(suite, "tests")
            self.failed += _suite_count(suite, "failures")
            self.errors += _suite_count(suite, "errors")
            self.skipped += _suite_count(suite, "skipped")
            self.duration_ms += sum(
                _safe_duration_ms(c) for c in suite if isinstance(c, JUnitTestCase)
            )
            return
        # A dialect may drop cases the suite attributes still count; count the
        # kept cases, which are the ones stored.
        self.total += len(kept)
        self.failed += sum(c.status == "failed" for c in kept)
        self.skipped += sum(c.status == "skipped" for c in kept)
        suite_ms = _suite_time_ms(suite)
        self.duration_ms += suite_ms if suite_ms is not None else sum(c.duration_ms for c in kept)

    def summary(self) -> RunSummary:
        return RunSummary(
            started_at=self.earliest,
            tests_total=self.total,
            tests_failed=self.failed,
            tests_errors=self.errors,
            tests_skipped=self.skipped,
            duration_ms=self.duration_ms,
        )


def _suite_time_ms(suite: TestSuite) -> int | None:
    """The <testsuite time> attribute in ms, read from the XML itself:
    junitparser's `suite.time` sums the child cases when the attribute is
    missing, which would count cases a dialect dropped. None when the
    attribute is missing, not a number, not finite, or negative."""
    try:
        raw = suite._elem.get("time")
        if raw is None:
            return None
        ms = float(raw) * 1000
    except Exception:
        return None
    if not math.isfinite(ms) or ms < 0:
        return None
    return int(round(ms))


def merge_summaries(summaries: Iterable[RunSummary]) -> RunSummary:
    """Combine per-file summaries into one run-level summary: earliest
    `started_at` across files, summed counts. The duration is unknown (None)
    if any file's duration is unknown."""
    earliest: datetime | None = None
    total = failed = errors = skipped = 0
    duration_ms: int | None = 0
    for s in summaries:
        if s.started_at is not None and (earliest is None or s.started_at < earliest):
            earliest = s.started_at
        total += s.tests_total
        failed += s.tests_failed
        errors += s.tests_errors
        skipped += s.tests_skipped
        duration_ms = (
            None if duration_ms is None or s.duration_ms is None else duration_ms + s.duration_ms
        )
    return RunSummary(
        started_at=earliest,
        tests_total=total,
        tests_failed=failed,
        tests_errors=errors,
        tests_skipped=skipped,
        duration_ms=duration_ms,
    )
