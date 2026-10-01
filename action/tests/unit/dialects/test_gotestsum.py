"""gotestsum dialect tests. Fixtures reproduce XML captured from
weaviate/weaviate CI jobs (subtests, testify output, package timeouts,
TestMain setup failures, nested Go modules)."""

from __future__ import annotations

import time
from pathlib import Path

from weaviate_test_reporter.parser import (
    MAX_TEXT_BYTES,
    parse_junit,
    parse_junit_file,
    parse_junit_summary,
)

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


# Real gotestsum output from a minimal module outside weaviate (two runs of
# the same code): `withmain` has a TestMain that logs during setup, `nomain`
# has no TestMain at all, `panicky` has an ordinary panic in a test.
PANICS_RUN1 = "gotestsum_panics_run1.xml"
PANICS_RUN2 = "gotestsum_panics_run2.xml"


def _pkg_cases(fixture: str, pkg: str) -> dict:
    return {
        c.name: c
        for c in parse_junit_file(FIXTURES / fixture)
        if c.test_suite == f"example.com/gosample/{pkg}"
    }


def test_gotestsum_timeout_found_after_package_setup_output():
    """gotestsum's TestMain case is the package's output from outside any
    test, not the user's TestMain function: setup logs can come before the
    timeout panic."""
    cases = _pkg_cases(PANICS_RUN1, "withmain")
    assert set(cases) == {"TestSlow/inner"}
    assert cases["TestSlow/inner"].error_message == "panic: test timed out after 2s"


def test_gotestsum_timeout_in_package_without_testmain():
    cases = _pkg_cases(PANICS_RUN1, "nomain")
    assert set(cases) == {"TestWait"}
    assert cases["TestWait"].error_message == "panic: test timed out after 2s"


def test_gotestsum_timed_out_test_stack_starts_with_its_own_output():
    """The test's own output comes first so the size cap trims the goroutine
    dump, not the test's logs."""
    stack = _pkg_cases(PANICS_RUN1, "withmain")["TestSlow/inner"].stack_trace
    assert stack is not None
    assert stack.startswith("=== RUN   TestSlow/inner")
    assert stack.index("waiting for index") < stack.index("panic: test timed out after 2s")
    assert "starting database container" in stack


def test_gotestsum_ordinary_panic_message():
    case = _pkg_cases(PANICS_RUN1, "panicky")["TestIndex"]
    assert case.error_message == (
        "panic: runtime error: index out of range [5] with length 3 [recovered, repanicked]"
    )


def test_gotestsum_panic_fingerprints_stable_across_runs():
    """Goroutine ids, other goroutines and the elapsed time change between
    runs of the same failure; the fingerprint must not."""
    run1 = {(c.test_suite, c.name): c for c in parse_junit_file(FIXTURES / PANICS_RUN1)}
    run2 = {(c.test_suite, c.name): c for c in parse_junit_file(FIXTURES / PANICS_RUN2)}
    failed = [k for k, c in run1.items() if c.status == "failed"]
    assert len(failed) == 3
    for key in failed:
        assert run1[key].failure_fingerprint is not None
        assert run1[key].failure_fingerprint == run2[key].failure_fingerprint, key


def test_gotestsum_different_panics_get_different_fingerprints():
    run1 = [c for c in parse_junit_file(FIXTURES / PANICS_RUN1) if c.status == "failed"]
    by_name = {c.name: c.failure_fingerprint for c in run1}
    assert by_name["TestIndex"] != by_name["TestWait"]
    assert by_name["TestWait"] != by_name["TestSlow/inner"]  # different running-test lists


def test_gotestsum_timeout_panic_kept_when_test_output_fills_the_cap(tmp_path):
    """The test's own output is already capped at MAX_TEXT_BYTES before the
    dialect runs. A timed-out test that printed that much must still store the
    panic and the running-test list, within the cap."""
    line = "    batching_test.go:224: Sent 200 articles&#xA;"
    xml = (FIXTURES / "gotestsum_timeout.xml").read_text()
    assert xml.count(line) == 1
    path = tmp_path / "big.xml"
    path.write_text(xml.replace(line, line * 1500))  # ~66 KB of the test's own output

    victim = {c.name: c for c in parse_junit_file(path)}[
        "TestGRPC_Batching/send_objects_and_references_as_fast_as_possible"
    ]
    stack = victim.stack_trace
    assert stack is not None
    assert len(stack.encode("utf-8")) <= MAX_TEXT_BYTES
    assert stack.startswith(
        "=== RUN   TestGRPC_Batching/send_objects_and_references_as_fast_as_possible"
    )
    assert "panic: test timed out after 1m30s" in stack
    assert "running tests:" in stack


# ---------- review round 4: uncapped output, timeout edge cases, summaries ----------

TIMEOUT_VICTIM = "TestGRPC_Batching/send_objects_and_references_as_fast_as_possible"
_TIMEOUT_START = '<failure message="Failed" type="">panic: test timed out'


def _write(tmp_path: Path, xml: str) -> Path:
    path = tmp_path / "junit.xml"
    path.write_text(xml)
    return path


def _with_setup_output(xml: str, setup: str) -> str:
    """The timeout fixture with `setup` printed by the package before the panic."""
    assert xml.count(_TIMEOUT_START) == 1
    return xml.replace(
        _TIMEOUT_START, '<failure message="Failed" type="">' + setup + "panic: test timed out"
    )


def test_gotestsum_message_found_after_more_than_32kb_of_output(tmp_path):
    """Go prints the failure reason last. The dialect must see the whole output,
    not the first MAX_TEXT_BYTES, or the message becomes the truncation marker."""
    line = "    plain_test.go:9: starting&#xA;"
    xml = (FIXTURES / "gotestsum_subtests.xml").read_text()
    path = _write(tmp_path, xml.replace(line, line * 1500))  # ~50 KB before the reason
    case = {c.name: c for c in parse_junit_file(path)}["TestPlainError"]
    assert case.error_message == "plain_test.go:10: want 3 objects, got 4"
    assert case.stack_trace is not None
    assert len(case.stack_trace.encode("utf-8")) <= MAX_TEXT_BYTES


def test_gotestsum_timeout_found_after_more_than_32kb_of_setup_output(tmp_path):
    setup = "setup: waiting for cluster node 0123456789&#xA;" * 1000  # ~40 KB
    xml = _with_setup_output((FIXTURES / "gotestsum_timeout.xml").read_text(), setup)
    cases = {c.name: c for c in parse_junit_file(_write(tmp_path, xml))}
    assert "TestMain" not in cases
    victim = cases[TIMEOUT_VICTIM]
    assert victim.error_message == "panic: test timed out after 1m30s"
    assert victim.stack_trace is not None
    assert len(victim.stack_trace.encode("utf-8")) <= MAX_TEXT_BYTES
    assert "panic: test timed out after 1m30s" in victim.stack_trace
    assert "running tests:" in victim.stack_trace


def test_gotestsum_timeout_panic_kept_with_setup_output_and_large_test_output(tmp_path):
    """Setup output before the panic must not push the panic out of the stored
    stack when the test's own output takes its half of the budget."""
    setup = "setup: waiting for cluster node 0123456789&#xA;" * 550  # ~22 KB
    own = "    batching_test.go:224: Sent 200 articles&#xA;"
    xml = _with_setup_output((FIXTURES / "gotestsum_timeout.xml").read_text(), setup)
    xml = xml.replace(own, own * 700)  # ~29 KB of the test's own output
    stack = {c.name: c for c in parse_junit_file(_write(tmp_path, xml))}[TIMEOUT_VICTIM].stack_trace
    assert stack is not None
    assert len(stack.encode("utf-8")) <= MAX_TEXT_BYTES
    assert "panic: test timed out after 1m30s" in stack
    assert "running tests:" in stack


def test_gotestsum_timeout_message_ignores_an_earlier_panic_line(tmp_path):
    """Only Go's timeout panic identifies the timeout; an earlier panic line in
    the package output (e.g. a logged, recovered panic) must not."""
    xml = _with_setup_output(
        (FIXTURES / "gotestsum_timeout.xml").read_text(),
        "panic: retrying connection (recovered)&#xA;",
    )
    victim = {c.name: c for c in parse_junit_file(_write(tmp_path, xml))}[TIMEOUT_VICTIM]
    assert victim.error_message == "panic: test timed out after 1m30s"
    clean = {c.name: c for c in parse_junit_file(FIXTURES / "gotestsum_timeout.xml")}
    assert victim.failure_fingerprint == clean[TIMEOUT_VICTIM].failure_fingerprint


def test_gotestsum_timeout_fingerprint_stable_with_compound_elapsed_times(tmp_path):
    """Go prints elapsed times like (1m12s); they differ between runs of the
    same timeout and must not change the fingerprint."""
    xml = (FIXTURES / "gotestsum_timeout.xml").read_text()
    assert "(1m12s)" in xml
    other = tmp_path / "other"
    other.mkdir()
    a = {c.name: c for c in parse_junit_file(_write(tmp_path, xml))}[TIMEOUT_VICTIM]
    b = {c.name: c for c in parse_junit_file(_write(other, xml.replace("(1m12s)", "(1m13s)")))}[
        TIMEOUT_VICTIM
    ]
    assert a.failure_fingerprint == b.failure_fingerprint


def test_gotestsum_finished_failure_under_a_running_parent_keeps_its_reason(tmp_path):
    """Go lists the parent of the hung subtest as running. A sibling that had
    already failed and finished (it has its own --- FAIL line) keeps its reason."""
    xml = (FIXTURES / "gotestsum_timeout_parent_listed.xml").read_text()
    passed = (
        '<testcase classname="github.com/weaviate/weaviate/entities/schema" '
        'name="TestNested/plain" time="0.000000"></testcase>'
    )
    assert passed in xml
    xml = xml.replace(
        passed,
        passed.replace(
            "></testcase>",
            '><failure message="Failed" type="">=== RUN   TestNested/plain&#xA;'
            "    a_test.go:10: want 3 objects, got 4&#xA;"
            "--- FAIL: TestNested/plain (0.00s)&#xA;</failure></testcase>",
        ),
    )
    cases = {c.name: c for c in parse_junit_file(_write(tmp_path, xml))}
    assert cases["TestNested/plain"].error_message == "a_test.go:10: want 3 objects, got 4"
    assert cases["TestNested/inner"].error_message == "panic: test timed out after 1ms"
    assert (
        cases["TestNested/plain"].failure_fingerprint
        != cases["TestNested/inner"].failure_fingerprint
    )


def test_gotestsum_tests_timed_out_together_share_the_timeout_fingerprint():
    """Every test the timeout caught gets the timeout's fingerprint, not one
    computed from its own output, so they group as one failure."""
    cases = _by_name("gotestsum_timeout_two_running.xml")
    assert set(cases) == {"TestA", "TestB"}
    assert cases["TestA"].failure_fingerprint is not None
    assert cases["TestA"].failure_fingerprint == cases["TestB"].failure_fingerprint


def test_gotestsum_panic_line_search_is_linear_on_blank_lines(tmp_path):
    """32 KB of blank lines took seconds with a regex that let leading
    whitespace span newlines."""
    xml = (FIXTURES / "gotestsum_subtests.xml").read_text()
    path = _write(
        tmp_path,
        xml.replace(
            "    plain_test.go:9: starting&#xA;",
            "&#xA;" * 32_000 + "    plain_test.go:9: starting&#xA;",
        ),
    )
    start = time.perf_counter()
    list(parse_junit_file(path))
    assert time.perf_counter() - start < 2.0


def test_gotestsum_unusable_suite_time_falls_back_to_kept_cases(tmp_path):
    """A non-numeric, non-finite, negative or missing <testsuite time> must not
    raise (the action is fail-safe); the duration falls back to the kept cases."""
    xml = (FIXTURES / "gotestsum_subtests.xml").read_text()
    kept_ms = sum(c.duration_ms for c in parse_junit_file(FIXTURES / "gotestsum_subtests.xml"))
    for value in ('time="oops"', 'time="NaN"', 'time="inf"', 'time="-5"', ""):
        sub = tmp_path / (value.replace('"', "").replace("=", "") or "missing")
        sub.mkdir()
        path = _write(sub, xml.replace('time="0.500000" name=', f"{value} name=".lstrip()))
        assert parse_junit_summary(path).duration_ms == kept_ms, value


def test_parse_junit_matches_the_separate_functions():
    """parse_junit returns in one pass what parse_junit_file plus
    parse_junit_summary return, for every fixture."""
    for path in sorted(FIXTURES.glob("*.xml")):
        cases, summary = parse_junit(path)
        assert cases == list(parse_junit_file(path)), path.name
        assert summary == parse_junit_summary(path), path.name
