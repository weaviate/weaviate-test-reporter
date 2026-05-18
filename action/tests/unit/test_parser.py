"""Parser tests.

Covers the four dialects in our compatibility matrix (pytest, gotestsum,
jest-junit, surefire) plus edge cases (large files, truncation, missing
attributes, mixed root elements).
"""

from __future__ import annotations

import tracemalloc
from pathlib import Path
from time import perf_counter

from weaviate_test_reporter.parser import MAX_TEXT_BYTES, TRUNC_MARKER, parse_junit_file

FIXTURES = Path(__file__).parent / "fixtures"


# ---------- pytest dialect ----------


def test_pytest_simple_yields_three_cases():
    cases = list(parse_junit_file(FIXTURES / "pytest_simple.xml"))
    assert len(cases) == 3


def test_pytest_simple_marks_statuses():
    cases = list(parse_junit_file(FIXTURES / "pytest_simple.xml"))
    assert sorted(c.status for c in cases) == ["failed", "passed", "skipped"]


def test_pytest_simple_extracts_failure_details():
    cases = list(parse_junit_file(FIXTURES / "pytest_simple.xml"))
    failed = next(c for c in cases if c.status == "failed")
    assert failed.failure_type == "AssertionError"
    assert failed.error_message is not None and "expected snapshot to exist" in failed.error_message
    assert failed.stack_trace is not None and "Traceback" in failed.stack_trace


def test_pytest_simple_duration_ms_is_int_ms():
    cases = list(parse_junit_file(FIXTURES / "pytest_simple.xml"))
    by_name = {c.name: c for c in cases}
    assert by_name["test_backup_creates_snapshot"].duration_ms == 1234
    assert by_name["test_restore_fails_on_missing"].duration_ms == 567
    assert by_name["test_backup_skip_when_disabled"].duration_ms == 1


def test_pytest_framework_detected():
    cases = list(parse_junit_file(FIXTURES / "pytest_simple.xml"))
    assert all(c.framework == "pytest" for c in cases)


def test_pytest_realistic_test_suite_uses_classname_not_pytest():
    """Real pytest-junit wraps every case in a single <testsuite name="pytest">.
    Falling back to suite.name would collapse every TestCase to "pytest" —
    useless for the dashboard's "top failing suite" KPI. The parser must
    pick the per-case classname instead (the actual module path).
    """
    cases = list(parse_junit_file(FIXTURES / "pytest_realistic.xml"))
    assert len(cases) == 3
    suites = {c.test_suite for c in cases}
    assert (
        "pytest" not in suites
    ), "test_suite must NOT collapse to the generic 'pytest' wrapper name"
    assert suites == {
        "tests.e2e.python_e2e.core.collection_alias_test",
        "tests.e2e.python_e2e.core.async_indexing_test",
        "tests.e2e.python_e2e.core.usage_metrics_test",
    }


# ---------- gotestsum dialect ----------


def test_gotestsum_yields_all_cases_across_suites():
    cases = list(parse_junit_file(FIXTURES / "gotestsum.xml"))
    assert len(cases) == 5  # 4 + 1 across two suites


def test_gotestsum_framework_detected():
    cases = list(parse_junit_file(FIXTURES / "gotestsum.xml"))
    assert all(c.framework == "golang" for c in cases)


def test_gotestsum_suite_names_match_packages():
    cases = list(parse_junit_file(FIXTURES / "gotestsum.xml"))
    suites = {c.test_suite for c in cases}
    assert "github.com/weaviate/weaviate/usecases/backup" in suites
    assert "github.com/weaviate/weaviate/adapters/repos/db" in suites


def test_gotestsum_failure_carries_stack_with_test_path():
    cases = list(parse_junit_file(FIXTURES / "gotestsum.xml"))
    failed = next(c for c in cases if c.status == "failed")
    assert failed.name == "TestBackup_RestoreFromMissing"
    assert failed.stack_trace is not None
    assert "backup_test.go:142" in failed.stack_trace
    # gotestsum often emits empty `type=""` on <failure>; we keep whatever
    # the XML provides verbatim (here: empty string) — filters can still use it.
    assert failed.failure_type == "" or failed.failure_type is None


def test_gotestsum_skipped_has_message():
    cases = list(parse_junit_file(FIXTURES / "gotestsum.xml"))
    skipped = next(c for c in cases if c.status == "skipped")
    assert skipped.error_message == "requires S3 credentials"


# ---------- jest-junit dialect ----------


def test_jest_yields_three_cases():
    cases = list(parse_junit_file(FIXTURES / "jest.xml"))
    assert len(cases) == 3


def test_jest_failure_unescapes_xml_entities():
    cases = list(parse_junit_file(FIXTURES / "jest.xml"))
    failed = next(c for c in cases if c.status == "failed")
    assert failed.stack_trace is not None
    # <anonymous> was XML-encoded in source; junitparser decodes it
    assert "<anonymous>" in failed.stack_trace
    assert "users.test.ts:42:11" in failed.stack_trace


def test_jest_no_type_attribute_is_none_or_empty():
    cases = list(parse_junit_file(FIXTURES / "jest.xml"))
    failed = next(c for c in cases if c.status == "failed")
    # jest-junit doesn't emit type="..." by default
    assert failed.failure_type in (None, "")


# ---------- surefire dialect ----------


def test_surefire_bare_testsuite_root():
    """Surefire emits a bare <testsuite> root (no <testsuites>). Must still parse."""
    cases = list(parse_junit_file(FIXTURES / "surefire.xml"))
    assert len(cases) == 2


def test_surefire_error_classified_as_failed():
    cases = list(parse_junit_file(FIXTURES / "surefire.xml"))
    error_case = next(c for c in cases if c.name == "testWidgetSerialize")
    assert error_case.status == "failed"  # <error> and <failure> both → failed
    assert error_case.failure_type == "java.lang.NullPointerException"
    assert error_case.stack_trace is not None
    assert "WidgetTest.java:42" in error_case.stack_trace


# ---------- edge cases ----------


def test_truncation_applied_to_huge_failure(tmp_path: Path):
    """A failure message larger than MAX_TEXT_BYTES gets truncated with marker."""
    huge = "x" * (MAX_TEXT_BYTES * 2)  # 64KB of 'x'
    xml = f"""<?xml version="1.0"?>
<testsuites>
  <testsuite name="huge" tests="1" failures="1">
    <testcase classname="huge" name="too_big" time="0.001">
      <failure type="HugeError" message="short">{huge}</failure>
    </testcase>
  </testsuite>
</testsuites>"""
    path = tmp_path / "huge.xml"
    path.write_text(xml)
    cases = list(parse_junit_file(path))
    assert len(cases) == 1
    case = cases[0]
    assert case.stack_trace is not None
    # The truncated bytes must be <= MAX_TEXT_BYTES
    assert len(case.stack_trace.encode("utf-8")) <= MAX_TEXT_BYTES
    assert case.stack_trace.endswith(TRUNC_MARKER)


def test_missing_time_attribute_defaults_to_zero(tmp_path: Path):
    xml = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="no_time" tests="1">
    <testcase classname="no_time" name="no_time_attr"/>
  </testsuite>
</testsuites>"""
    path = tmp_path / "no_time.xml"
    path.write_text(xml)
    cases = list(parse_junit_file(path))
    assert cases[0].duration_ms == 0


def test_empty_testsuite_yields_no_cases(tmp_path: Path):
    xml = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="empty" tests="0"/>
</testsuites>"""
    path = tmp_path / "empty.xml"
    path.write_text(xml)
    cases = list(parse_junit_file(path))
    assert cases == []


# ---------- large-file streaming benchmark ----------


def _build_large_xml(num_cases: int) -> str:
    """Build a synthetic JUnit XML approximately 10MB+ in size.

    Shape mirrors a realistic Weaviate e2e suite: many cases per file (a few
    thousand), 25% failure rate, failure payload ~8KB per case (real stack
    traces from goroutine dumps run that long).
    """
    chunks: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<testsuites>",
        f'<testsuite name="synth" tests="{num_cases}" '
        f'failures="{num_cases // 4}" time="120.0">',
    ]
    big_payload = "stack frame line " * 500  # ~8.5KB
    for i in range(num_cases):
        if i % 4 == 0:
            chunks.append(
                f'<testcase classname="synth.module_{i % 20}" '
                f'name="test_case_{i}" time="0.05">'
                f'<failure type="SynthError" message="boom {i}">{big_payload}</failure>'
                f"</testcase>"
            )
        else:
            chunks.append(
                f'<testcase classname="synth.module_{i % 20}" '
                f'name="test_case_{i}" time="0.01"/>'
            )
    chunks.append("</testsuite>")
    chunks.append("</testsuites>")
    return "\n".join(chunks)


def test_large_file_parses_within_budget(tmp_path: Path):
    """Parses ~10MB JUnit file in <5s wall and <100MB peak Python heap.

    junitparser delegates the heavy lifting to lxml (C-level allocation),
    so tracemalloc only sees Python-side overhead — the ParsedCase objects
    we yield plus parse temporaries. If we ever regress and start
    accumulating cases in a list instead of yielding, this jumps fast.

    Wall-time budget is the second guard: any DOM-traversal regression that
    is O(N^2) would blow past 5s on 5000 cases.
    """
    path = tmp_path / "large.xml"
    path.write_text(_build_large_xml(num_cases=5000))
    size_mb = path.stat().st_size / (1024 * 1024)
    assert size_mb >= 8, f"synthetic fixture too small: {size_mb:.1f} MB"

    tracemalloc.start()
    start = perf_counter()
    count = sum(1 for _ in parse_junit_file(path))
    elapsed = perf_counter() - start
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    peak_mb = peak / (1024 * 1024)
    assert count == 5000
    assert elapsed < 5.0, f"parsing took {elapsed:.2f}s (budget 5s)"
    assert peak_mb < 100, f"peak Python heap {peak_mb:.1f}MB exceeds 100MB budget"


def test_parse_junit_file_is_a_generator(tmp_path: Path):
    """parse_junit_file must be a true generator — the caller controls
    consumption and can pipe directly into the Weaviate batch context
    without first materializing a list.
    """
    import types

    path = tmp_path / "synth_small.xml"
    path.write_text(_build_large_xml(num_cases=10))
    result = parse_junit_file(path)
    assert isinstance(result, types.GeneratorType)
    # First call to next() should produce a real ParsedCase
    first = next(result)
    assert first.name == "test_case_0"
