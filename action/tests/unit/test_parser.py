"""Parser tests.

Covers the four dialects in our compatibility matrix (pytest, gotestsum,
jest-junit, surefire) plus edge cases (large files, truncation, missing
attributes, mixed root elements).
"""

from __future__ import annotations

import tracemalloc
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

from weaviate_test_reporter.parser import (
    MAX_TEXT_BYTES,
    TRUNC_MARKER,
    merge_summaries,
    normalize_stack_trace,
    parse_junit_file,
    parse_junit_summary,
    stack_trace_fingerprint,
)

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


# ---------- D3: retry / rerun capture (per-case) ----------


def test_surefire_reruns_flaky_pass_is_passed_on_retry():
    """A surefire <flakyFailure> case that ultimately PASSED is the
    gold-standard flake signal: retry_count counts the flaky elements,
    passed_on_retry is True, initial_status records the first-attempt fail."""
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "surefire_reruns.xml")}
    flaky = cases["testEventuallyPasses"]
    assert flaky.status == "passed"
    assert flaky.retry_count == 2
    assert flaky.passed_on_retry is True
    assert flaky.initial_status == "failed"


def test_surefire_reruns_final_failure_is_not_passed_on_retry():
    """A case with <rerunFailure> retries that still ends in <failure> is a
    real failure, not a flake — passed_on_retry must be False."""
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "surefire_reruns.xml")}
    failed = cases["testTrulyFails"]
    assert failed.status == "failed"
    assert failed.retry_count == 1
    assert failed.passed_on_retry is False
    assert failed.initial_status == "failed"


def test_surefire_reruns_clean_pass_has_no_retries():
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "surefire_reruns.xml")}
    clean = cases["testPassesClean"]
    assert clean.status == "passed"
    assert clean.retry_count == 0
    assert clean.passed_on_retry is False
    assert clean.initial_status == "passed"


def test_dialects_without_reruns_yield_zero_retry_fields():
    """pytest / gotestsum / jest emit no rerun elements — every case must
    degrade to retry_count=0, passed_on_retry=False, initial_status==status."""
    for fixture in ("pytest_simple.xml", "gotestsum.xml", "jest.xml"):
        for c in parse_junit_file(FIXTURES / fixture):
            assert c.retry_count == 0, f"{fixture}:{c.name}"
            assert c.passed_on_retry is False, f"{fixture}:{c.name}"
            assert c.initial_status == c.status, f"{fixture}:{c.name}"


def test_flaky_error_that_recovers_is_passed_on_retry():
    """<flakyError> (error-type retry) that ultimately passes is a flake,
    same as <flakyFailure>: retry_count counts the error retries."""
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "surefire_rerun_edge.xml")}
    flaky = cases["testFlakyErrorRecovers"]
    assert flaky.status == "passed"
    assert flaky.retry_count == 2
    assert flaky.passed_on_retry is True
    assert flaky.initial_status == "failed"


def test_rerun_error_with_final_error_is_not_flaky():
    """<rerunError> retries followed by a final <error> is a real failure."""
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "surefire_rerun_edge.xml")}
    failed = cases["testErrorsAfterReruns"]
    assert failed.status == "failed"
    assert failed.retry_count == 1
    assert failed.passed_on_retry is False
    assert failed.initial_status == "failed"


def test_retried_then_skipped_is_not_passed_on_retry():
    """A case that failed once then ended SKIPPED (e.g. quarantined) must
    record the retry but NOT count as passed-on-retry."""
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "surefire_rerun_edge.xml")}
    skipped = cases["testRetriedThenSkipped"]
    assert skipped.status == "skipped"
    assert skipped.retry_count == 1
    assert skipped.passed_on_retry is False
    assert skipped.initial_status == "failed"


# ---------- D4: stack-trace fingerprint ----------


def test_normalize_strips_volatile_line_numbers_and_addresses():
    """Two traces that differ only in line numbers, hex addresses, tmp
    paths, and timestamps must normalize to the SAME string."""
    a = (
        "2026-06-30T14:23:11Z ERROR at /tmp/build-abc123/mod.py:42 "
        "frame 0x7f8a2b1c line 42: RuntimeError: connection reset"
    )
    b = (
        "2026-07-01T09:00:05Z ERROR at /tmp/build-def999/mod.py:87 "
        "frame 0x9c1d3e00 line 87: RuntimeError: connection reset"
    )
    assert normalize_stack_trace(a) == normalize_stack_trace(b)


def test_normalize_keeps_distinct_error_shapes_distinct():
    """Distinct error messages / types must NOT collapse — over-normalization
    would make R4 clustering merge unrelated bugs."""
    a = "at mod.py:42: RuntimeError: connection reset"
    b = "at mod.py:42: ValueError: expected non-empty payload"
    assert normalize_stack_trace(a) != normalize_stack_trace(b)


def test_fingerprint_is_stable_16_char_hex():
    fp = stack_trace_fingerprint("at mod.py:42: RuntimeError: boom")
    assert fp is not None
    assert len(fp) == 16
    assert all(ch in "0123456789abcdef" for ch in fp)
    # deterministic
    assert fp == stack_trace_fingerprint("at mod.py:99: RuntimeError: boom")


def test_fingerprint_none_for_empty():
    assert stack_trace_fingerprint(None) is None
    assert stack_trace_fingerprint("") is None


def test_failed_case_has_fingerprint_passed_and_skipped_do_not():
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "pytest_simple.xml")}
    failed = cases["test_restore_fails_on_missing"]
    passed = cases["test_backup_creates_snapshot"]
    skipped = cases["test_backup_skip_when_disabled"]
    assert failed.failure_fingerprint is not None
    assert len(failed.failure_fingerprint) == 16
    assert passed.failure_fingerprint is None
    assert skipped.failure_fingerprint is None


def test_identical_failures_share_a_fingerprint():
    """Two failing cases whose traces differ only in volatile tokens must
    produce the same fingerprint — the exact-match dedup key for R4."""
    a = stack_trace_fingerprint("panic at /tmp/x-1/a.go:10 addr 0x1a")
    b = stack_trace_fingerprint("panic at /tmp/x-2/a.go:55 addr 0x2b")
    assert a == b


def test_gotestsum_fingerprint_stable_across_elapsed_durations():
    """Go/gotestsum failures end with `--- FAIL: TestX (0.08s)`. The elapsed
    time is volatile run-to-run; it must NOT fragment the fingerprint (this
    would shatter R4 clustering for the ecosystem's primary language)."""
    cases = {c.name: c for c in parse_junit_file(FIXTURES / "gotestsum.xml")}
    failed = cases["TestBackup_RestoreFromMissing"]
    assert failed.stack_trace is not None and "(0.08s)" in failed.stack_trace
    fp_a = stack_trace_fingerprint(failed.stack_trace)
    fp_b = stack_trace_fingerprint(failed.stack_trace.replace("(0.08s)", "(0.12s)"))
    assert fp_a == fp_b


def test_normalize_collapses_go_duration_units():
    """All Go elapsed-time suffixes collapse to one token regardless of unit
    or magnitude."""
    baseline = normalize_stack_trace("panic in TestX (0.08s)")
    for dur in ("(5s)", "(1.5m)", "(200ms)", "(3µs)", "(45us)", "(2h)", "(900ns)"):
        assert normalize_stack_trace(f"panic in TestX {dur}") == baseline


def test_go_duration_normalization_keeps_distinct_failures_distinct():
    """The duration collapse must not merge genuinely different Go failures."""
    a = "--- FAIL: TestFoo (0.08s)\n    foo_test.go:10: assertion failed"
    b = "--- FAIL: TestFoo (0.08s)\n    foo_test.go:10: nil pointer dereference"
    assert stack_trace_fingerprint(a) != stack_trace_fingerprint(b)


def test_normalize_strips_ci_runner_work_dirs():
    """The same failure fingerprints identically across GitHub-hosted,
    self-hosted, and legacy runner work directories."""
    gh = "FAIL at /home/runner/work/repo/repo/pkg/x_test.go:12"
    self_hosted = "FAIL at /home/actions-runner/_work/repo/repo/pkg/x_test.go:12"
    legacy = "FAIL at /runner/_work/repo/repo/pkg/x_test.go:12"
    assert normalize_stack_trace(gh) == normalize_stack_trace(self_hosted)
    assert normalize_stack_trace(self_hosted) == normalize_stack_trace(legacy)


def test_runner_prefix_stripped_but_repo_relative_path_kept():
    """Only the volatile runner checkout prefix is noise; the repo-relative path
    is part of the failure's identity. Distinct files under the SAME runner
    prefix must keep DISTINCT fingerprints (else R4 clustering would merge
    unrelated failures that differ only by file)."""
    a = "FAIL at /home/runner/work/repo/repo/pkg/a_test.go:12: boom"
    b = "FAIL at /home/runner/work/repo/repo/pkg/b_test.go:12: boom"
    assert stack_trace_fingerprint(a) != stack_trace_fingerprint(b)
    # the repo-relative path survives normalization; only the prefix is gone
    normalized = normalize_stack_trace(a)
    assert "pkg/a_test.go" in normalized
    assert "/home/runner/work" not in normalized


# ---------- D1 + D2: run summary (started_at + counts) ----------


def test_parse_summary_reads_earliest_timestamp():
    """started_at is the earliest <testsuite timestamp> across all suites."""
    summary = parse_junit_summary(FIXTURES / "timestamped_counts.xml")
    assert summary.started_at == datetime(2026, 6, 30, 9, 30, 0, tzinfo=UTC)


def test_parse_summary_sums_counts_across_suites():
    """tests_* come from the <testsuite tests= failures= errors= skipped=>
    attributes summed across suites (not from per-case classification)."""
    summary = parse_junit_summary(FIXTURES / "timestamped_counts.xml")
    assert summary.tests_total == 5
    assert summary.tests_failed == 1
    assert summary.tests_errors == 1
    assert summary.tests_skipped == 1


def test_parse_summary_naive_timestamp_assumed_utc():
    """Surefire emits a timezone-naive timestamp; we treat it as UTC so the
    Weaviate DATE column is always timezone-aware."""
    summary = parse_junit_summary(FIXTURES / "surefire_reruns.xml")
    assert summary.started_at == datetime(2026, 6, 30, 14, 23, 11, tzinfo=UTC)


def test_parse_summary_no_timestamp_returns_none():
    """pytest-junit rarely emits a timestamp — started_at falls back to None
    so the caller can substitute ingest time."""
    summary = parse_junit_summary(FIXTURES / "pytest_simple.xml")
    assert summary.started_at is None
    # counts still populate (junitparser recomputes from children when the
    # attributes are absent).
    assert summary.tests_total == 3


def test_parse_summary_recomputes_counts_when_attributes_absent():
    """D2 fallback: a <testsuite> that omits tests=/failures=/errors=/skipped=
    must still yield correct run-level counts (recomputed from child cases).
    This is what makes the D2 counts robust for dialects that skip the
    summary attributes."""
    summary = parse_junit_summary(FIXTURES / "no_count_attributes.xml")
    assert summary.tests_total == 4
    assert summary.tests_failed == 1
    assert summary.tests_errors == 1
    assert summary.tests_skipped == 1


def test_parse_summary_is_fail_safe_on_garbage(tmp_path: Path):
    """A malformed XML must never raise — the action can't break CI."""
    bad = tmp_path / "bad.xml"
    bad.write_text("<not-junit>>>garbage")
    summary = parse_junit_summary(bad)
    assert summary.started_at is None
    assert summary.tests_total == 0


def test_merge_summaries_picks_min_timestamp_and_sums_counts():
    a = parse_junit_summary(FIXTURES / "timestamped_counts.xml")
    b = parse_junit_summary(FIXTURES / "surefire_reruns.xml")
    merged = merge_summaries([a, b])
    # earliest across both files
    assert merged.started_at == datetime(2026, 6, 30, 9, 30, 0, tzinfo=UTC)
    assert merged.tests_total == a.tests_total + b.tests_total
    assert merged.tests_failed == a.tests_failed + b.tests_failed


def test_merge_summaries_empty_is_null_summary():
    merged = merge_summaries([])
    assert merged.started_at is None
    assert merged.tests_total == 0
