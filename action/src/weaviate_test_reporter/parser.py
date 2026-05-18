"""JUnit XML -> ParsedCase dataclasses.

Handles pytest, gotestsum, jest, and surefire dialects via junitparser, which
wraps lxml under the hood. Designed to be a pure-function streaming iterator
so callers can keep memory bounded on large CI reports.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from junitparser import Error, Failure, JUnitXml, Skipped, TestSuite
from junitparser import TestCase as JUnitTestCase

MAX_TEXT_BYTES = 32_768
TRUNC_MARKER = "\n[... truncated]"


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
            yield ParsedCase(
                name=case.name or "unknown",
                test_suite=_pick_test_suite(case, fallback_suite_name),
                framework=_detect_framework(case),
                status=status,
                duration_ms=int(round((case.time or 0) * 1000)),
                error_message=msg,
                stack_trace=stack,
                failure_type=ftype,
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
