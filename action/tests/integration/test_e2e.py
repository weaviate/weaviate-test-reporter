"""End-to-end integration test against a real Weaviate.

Exercises the full ingestion pipeline (parser -> schema -> ingest) and
verifies the contract from the consumer's perspective: the data lands
in Weaviate exactly as the dashboard will read it back.

Test scope:
- TestRun + TestCases land with the correct property values.
- belongsToRun cross-references resolve to the actual TestRun.
- Idempotency: re-running the same workflow attempt does NOT duplicate
  rows (UUID5 collision -> upsert).
- A different attempt of the same run produces a separate TestRun.
- The full ParsedCase -> Weaviate property round-trip preserves data.

Why no semantic search assertion: the production vectorizer
(text2vec-weaviate) requires Weaviate Cloud connectivity that our
testcontainers instance doesn't have. The Configure.Vectorizer.none()
override in conftest exercises the path without that dependency. A
separate WCD-only integration test (gated on secrets) can cover
semantic search end-to-end.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from weaviate.classes.query import Filter, QueryReference

from weaviate_test_reporter.config import Config
from weaviate_test_reporter.ingest import (
    _run_uuid,
    ingest_test_cases,
    insert_test_run,
)
from weaviate_test_reporter.parser import parse_junit_file
from weaviate_test_reporter.schema import TEST_CASE, TEST_RUN

FIXTURE = Path(__file__).parent.parent / "unit" / "fixtures" / "pytest_simple.xml"


pytestmark = pytest.mark.integration


def _meta(**overrides):
    base = {
        "repository": "weaviate/weaviate-test-reporter",
        "workflow_run_id": "999",
        "workflow_run_attempt": 1,
        "workflow_name": "ci",
        "branch": "main",
        "commit_hash": "cafe0123",
        "trigger_type": "push",
        "actor": "integration-bot",
        "pr_number": None,
        "run_url": "https://github.com/weaviate/weaviate-test-reporter/actions/runs/999/attempts/1",
    }
    base.update(overrides)
    return base


def _cfg(**overrides):
    kwargs = {
        "weaviate_url": "http://localhost:8080",
        "weaviate_api_key": "",
        "junit_path": str(FIXTURE),
        "job_name": "integration",
        "fail_on_error": True,
        "vectorizer": "text2vec-model2vec",
        "model2vec_inference_url": "http://model2vec:8080",
        "verbose": False,
    }
    kwargs.update(overrides)
    return Config(**kwargs)


def _ingest_pipeline(client, meta, cfg):
    cases = list(parse_junit_file(FIXTURE))
    run_uuid = insert_test_run(client, cases, meta, cfg)
    successful, failed = ingest_test_cases(
        client, cases, run_uuid,
        repository=meta["repository"],
        workflow_run_id=meta["workflow_run_id"],
        workflow_run_attempt=meta["workflow_run_attempt"],
    )
    return run_uuid, cases, successful, failed


def test_full_pipeline_lands_one_run_and_three_cases(weaviate_client):
    run_uuid, cases, successful, failed = _ingest_pipeline(
        weaviate_client, _meta(), _cfg()
    )

    assert successful == 3
    assert failed == 0
    assert len(cases) == 3

    runs = weaviate_client.collections.get(TEST_RUN).query.fetch_objects(limit=10)
    assert len(runs.objects) == 1
    assert str(runs.objects[0].uuid) == run_uuid

    test_cases = weaviate_client.collections.get(TEST_CASE).query.fetch_objects(limit=10)
    assert len(test_cases.objects) == 3


def test_test_run_carries_aggregated_properties(weaviate_client):
    run_uuid, _, _, _ = _ingest_pipeline(weaviate_client, _meta(), _cfg())

    run_obj = weaviate_client.collections.get(TEST_RUN).query.fetch_object_by_id(run_uuid)
    assert run_obj is not None
    props = run_obj.properties

    assert props["repository"] == "weaviate/weaviate-test-reporter"
    assert props["workflow_run_id"] == "999"
    assert props["workflow_run_attempt"] == 1
    assert props["job_name"] == "integration"
    assert props["actor"] == "integration-bot"
    # 1 fail in the fixture -> overall status is failure
    assert props["status"] == "failure"
    # 1234 + 567 + 1 ms from the fixture
    assert props["total_duration_ms"] == 1234 + 567 + 1


def test_test_cases_carry_failure_details(weaviate_client):
    _ingest_pipeline(weaviate_client, _meta(), _cfg())

    failed_cases = weaviate_client.collections.get(TEST_CASE).query.fetch_objects(
        filters=Filter.by_property("status").equal("failed"),
        limit=10,
    )
    assert len(failed_cases.objects) == 1
    case = failed_cases.objects[0]
    assert case.properties["name"] == "test_restore_fails_on_missing"
    assert case.properties["failure_type"] == "AssertionError"
    assert "expected snapshot to exist" in case.properties["error_message"]
    assert "Traceback" in case.properties["stack_trace"]


def test_belongs_to_run_cross_reference_resolves(weaviate_client):
    """Every TestCase must link back to its TestRun via belongsToRun."""
    run_uuid, _, _, _ = _ingest_pipeline(weaviate_client, _meta(), _cfg())

    test_cases = weaviate_client.collections.get(TEST_CASE).query.fetch_objects(
        return_references=QueryReference(link_on="belongsToRun"),
        limit=10,
    )
    assert len(test_cases.objects) == 3
    for obj in test_cases.objects:
        ref = obj.references["belongsToRun"]
        # The reference must point at exactly the inserted run UUID.
        ref_uuids = [str(o.uuid) for o in ref.objects]
        assert ref_uuids == [run_uuid], (
            f"case {obj.properties['name']!r} cross-ref={ref_uuids}, "
            f"expected [{run_uuid!r}]"
        )


def test_idempotent_re_run_does_not_duplicate(weaviate_client):
    """Re-running the same workflow attempt must upsert, not duplicate."""
    _ingest_pipeline(weaviate_client, _meta(), _cfg())
    # Re-run identically
    _ingest_pipeline(weaviate_client, _meta(), _cfg())

    runs = weaviate_client.collections.get(TEST_RUN).query.fetch_objects(limit=10)
    cases = weaviate_client.collections.get(TEST_CASE).query.fetch_objects(limit=10)
    assert len(runs.objects) == 1, "TestRun count must stay 1 after idempotent re-run"
    assert len(cases.objects) == 3, "TestCase count must stay 3 after idempotent re-run"


def test_different_attempt_produces_separate_run(weaviate_client):
    """workflow_run_attempt=1 and =2 are intentionally distinct runs (the
    user wants to compare retries)."""
    _ingest_pipeline(weaviate_client, _meta(workflow_run_attempt=1), _cfg())
    _ingest_pipeline(weaviate_client, _meta(workflow_run_attempt=2), _cfg())

    runs = weaviate_client.collections.get(TEST_RUN).query.fetch_objects(limit=10)
    cases = weaviate_client.collections.get(TEST_CASE).query.fetch_objects(limit=10)

    run_uuids = {str(r.uuid) for r in runs.objects}
    expected_uuids = {
        _run_uuid(_meta()["repository"], "999", 1),
        _run_uuid(_meta()["repository"], "999", 2),
    }
    assert run_uuids == expected_uuids
    assert len(cases.objects) == 6  # 3 cases x 2 attempts


def test_filter_by_failure_type(weaviate_client):
    """A core dogfood query: 'show me everything that failed with
    AssertionError'. Must work with the inverted index over failure_type."""
    _ingest_pipeline(weaviate_client, _meta(), _cfg())

    result = weaviate_client.collections.get(TEST_CASE).query.fetch_objects(
        filters=Filter.by_property("failure_type").equal("AssertionError"),
        limit=10,
    )
    assert len(result.objects) == 1
    assert result.objects[0].properties["name"] == "test_restore_fails_on_missing"


# ---------- semantic search (text2vec-model2vec) ----------


def test_semantic_search_finds_similar_failures(weaviate_client):
    """The headline dogfood: paste a failure message, get semantically
    similar TestCases ranked back. With named vectors we MUST specify
    target_vector — pointing at `stack_trace` since that's the highest-
    signal slot for triage.
    """
    _ingest_pipeline(weaviate_client, _meta(), _cfg())

    result = weaviate_client.collections.get(TEST_CASE).query.near_text(
        query="snapshot does not exist restore failed",
        target_vector="stack_trace",
        limit=3,
        filters=Filter.by_property("status").equal("failed"),
    )
    assert len(result.objects) == 1
    top = result.objects[0]
    assert top.properties["name"] == "test_restore_fails_on_missing"
    assert top.properties["failure_type"] == "AssertionError"


def test_semantic_search_can_target_different_named_vectors(weaviate_client):
    """Named vectors let the same query produce different rankings
    depending on which vector slot you target. Smoke-test that all three
    vectors return results without error.
    """
    _ingest_pipeline(weaviate_client, _meta(), _cfg())

    for target in ("name", "error_message", "stack_trace"):
        result = weaviate_client.collections.get(TEST_CASE).query.near_text(
            query="snapshot restore failed",
            target_vector=target,
            limit=3,
        )
        # All three slots are populated, so each query must return at
        # least one object.
        assert len(result.objects) >= 1, f"target_vector={target!r} returned 0"


def test_semantic_search_ranks_relevant_above_unrelated(weaviate_client):
    """Insert a synthetic mix of failures with distinct semantic content
    and verify the vectorizer ranks them in the expected order."""
    from weaviate_test_reporter.ingest import insert_test_run, ingest_test_cases
    from weaviate_test_reporter.parser import ParsedCase

    cases = [
        ParsedCase(
            name="test_kubernetes_pod_oom",
            test_suite="suite_k8s",
            framework="pytest",
            status="failed",
            duration_ms=100,
            error_message="pod killed due to OOM, memory limit exceeded",
            stack_trace="OOMKilled: container ran out of memory at 2GiB limit",
            failure_type="ResourceError",
        ),
        ParsedCase(
            name="test_database_timeout",
            test_suite="suite_db",
            framework="pytest",
            status="failed",
            duration_ms=100,
            error_message="connection to postgres timed out after 30s",
            stack_trace="psycopg2.OperationalError: connection timeout",
            failure_type="TimeoutError",
        ),
        ParsedCase(
            name="test_string_formatting",
            test_suite="suite_util",
            framework="pytest",
            status="failed",
            duration_ms=100,
            error_message="format string contained invalid placeholder",
            stack_trace='ValueError: Unknown format code "z" for object of type "str"',
            failure_type="ValueError",
        ),
    ]
    meta = _meta(workflow_run_id="888")
    cfg = _cfg()
    run_uuid = insert_test_run(weaviate_client, cases, meta, cfg)
    ingest_test_cases(
        weaviate_client, cases, run_uuid,
        repository=meta["repository"],
        workflow_run_id=meta["workflow_run_id"],
        workflow_run_attempt=meta["workflow_run_attempt"],
    )

    # Query for memory issues against the stack_trace vector — the OOM
    # case must rank highest since "ran out of memory" matches its trace.
    result = weaviate_client.collections.get(TEST_CASE).query.near_text(
        query="container ran out of memory in kubernetes",
        target_vector="stack_trace",
        limit=3,
    )
    assert len(result.objects) >= 1
    assert result.objects[0].properties["name"] == "test_kubernetes_pod_oom", (
        f"top hit was {result.objects[0].properties['name']!r}, expected OOM case"
    )


def test_vectorization_actually_runs(weaviate_client):
    """Smoke: TestCase vectorization is actually wired up.

    - Every case must have the `name` vector (every case has a name).
    - The failed case must have all three named vectors (it has a stack
      trace and error message).
    - Passed/skipped cases without a stack_trace won't get the stack_trace
      slot populated — that's correct behavior; Weaviate skips empty
      sources.
    """
    _ingest_pipeline(weaviate_client, _meta(), _cfg())

    result = weaviate_client.collections.get(TEST_CASE).query.fetch_objects(
        limit=10,
        include_vector=True,
    )
    assert len(result.objects) > 0

    failed_with_all_slots = 0
    for obj in result.objects:
        assert obj.vector, f"TestCase {obj.properties['name']!r} has no vectors"
        # `name` is always populated for every case.
        assert "name" in obj.vector, (
            f"{obj.properties['name']!r} missing 'name' vector"
        )
        for slot, vec_values in obj.vector.items():
            assert len(vec_values) > 0, (
                f"{obj.properties['name']!r} has empty vector for slot {slot!r}"
            )
        if set(obj.vector.keys()) == {"name", "error_message", "stack_trace"}:
            failed_with_all_slots += 1

    # At least the one failed case in the fixture must have all three slots.
    assert failed_with_all_slots >= 1, (
        "expected at least one TestCase with all three named vectors "
        "(populated when name + error_message + stack_trace are all set)"
    )


