"""gotestsum dialect tests. Fixtures reproduce XML captured from
weaviate/weaviate CI jobs (subtests, testify output, package timeouts,
TestMain setup failures, nested Go modules)."""

from __future__ import annotations

from pathlib import Path

from weaviate_test_reporter.parser import parse_junit_file, parse_junit_summary

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _by_name(fixture: str) -> dict:
    return {c.name: c for c in parse_junit_file(FIXTURES / fixture)}


def test_gotestsum_failed_parent_of_failing_subtest_is_dropped():
    """Go marks a parent failed when any subtest fails, so reporting both
    double-counts one failure. The failing subtest carries the signal."""
    cases = _by_name("gotestsum_subtests.xml")
    assert "TestProbeAssert" not in cases
    assert cases["TestProbeAssert/sub_fail"].status == "failed"
    assert cases["TestProbeAssert/sub_ok"].status == "passed"


def test_gotestsum_passing_parent_and_failing_leaf_without_subtests_are_kept():
    cases = _by_name("gotestsum_subtests.xml")
    assert cases["TestAllGreen"].status == "passed"
    assert cases["TestAllGreen/case_a"].status == "passed"
    assert cases["TestPlainError"].status == "failed"


def test_gotestsum_message_comes_from_first_testify_error_block():
    """gotestsum sets message="Failed" on every failure; the real reason is
    the testify `Error:` block in the body (plus its `Messages:` line)."""
    failed = _by_name("gotestsum_subtests.xml")["TestProbeAssert/sub_fail"]
    assert failed.error_message == "Not equal: expected: 3 actual : 4 — object count after import"
    assert failed.stack_trace is not None and "Error Trace:" in failed.stack_trace


def test_gotestsum_message_from_testify_error_without_messages_line():
    cases = _by_name("gotestsum.xml")
    failed = cases["TestBackup_RestoreFromMissing"]
    assert (
        failed.error_message == "Received unexpected error: snapshot s3://bucket/missing not found"
    )


def test_gotestsum_message_falls_back_to_last_output_line():
    failed = _by_name("gotestsum_subtests.xml")["TestPlainError"]
    assert failed.error_message == "plain_test.go:10: want 3 objects, got 4"


def test_gotestsum_timeout_moves_panic_onto_the_running_test():
    """A package timeout yields a synthetic TestMain case holding the panic;
    the test that was running gets only its own log lines. The reason is
    copied onto the running leaf test and TestMain + the parent are dropped."""
    cases = _by_name("gotestsum_timeout.xml")
    assert "TestMain" not in cases
    assert "TestGRPC_Batching" not in cases
    victim = cases["TestGRPC_Batching/send_objects_and_references_as_fast_as_possible"]
    assert victim.status == "failed"
    assert victim.error_message == "panic: test timed out after 1m30s"
    assert victim.stack_trace is not None
    assert "running tests:" in victim.stack_trace
    assert "Sent 200 articles" in victim.stack_trace
    assert victim.failure_fingerprint is not None
    passed = cases["TestGRPC_Batching/send_objects_and_references_without_errors"]
    assert passed.status == "passed"


def test_gotestsum_testmain_failure_without_timeout_is_kept():
    """TestMain failing on its own (e.g. cluster setup) is the only record of
    that package's failure — keep it, labelled as Go."""
    cases = _by_name("gotestsum_testmain_setup.xml")
    main = cases["TestMain"]
    assert main.status == "failed"
    assert main.framework == "golang"
    assert (
        main.test_suite
        == "github.com/weaviate/weaviate/test/acceptance/replication/async_replication"
    )
    assert (
        main.error_message is not None
        and "compose up: container weaviate-0 exited" in main.error_message
    )


def test_gotestsum_framework_from_go_version_property():
    """Nested Go modules have non-github.com import paths; the suite's
    go.version property still identifies them as Go."""
    cases = list(parse_junit_file(FIXTURES / "gotestsum_nested_module.xml"))
    assert cases and all(c.framework == "golang" for c in cases)


def test_gotestsum_summary_counts_match_kept_cases():
    """Run-level counts for Go suites are recomputed from the kept cases so
    they agree with the stored TestCase rows (no dropped rollups/TestMain)."""
    s = parse_junit_summary(FIXTURES / "gotestsum_subtests.xml")
    assert (s.tests_total, s.tests_failed, s.tests_skipped, s.tests_errors) == (5, 2, 0, 0)
    t = parse_junit_summary(FIXTURES / "gotestsum_timeout.xml")
    assert (t.tests_total, t.tests_failed) == (2, 1)
    m = parse_junit_summary(FIXTURES / "gotestsum_testmain_setup.xml")
    assert (m.tests_total, m.tests_failed) == (1, 1)


def test_gotestsum_timeout_reason_reaches_failing_subtest_of_listed_parent():
    """The panic may list only the parent as running. The reason must land on
    the failing subtest that is kept, not on the parent that is dropped."""
    cases = _by_name("gotestsum_timeout_parent_listed.xml")
    assert set(cases) == {"TestNested/plain", "TestNested/inner"}
    assert cases["TestNested/inner"].error_message == "panic: test timed out after 1ms"


def test_gotestsum_run_duration_is_suite_time_not_case_sum():
    """Go parents include their subtests' time, so summing cases
    double-counts; a dropped parent loses time. The suite `time` attribute
    is the package's wall-clock."""
    assert parse_junit_summary(FIXTURES / "gotestsum_nested_module.xml").duration_ms == 522_525
    assert parse_junit_summary(FIXTURES / "gotestsum_timeout.xml").duration_ms == 90_100
    assert parse_junit_summary(FIXTURES / "gotestsum_subtests.xml").duration_ms == 500
