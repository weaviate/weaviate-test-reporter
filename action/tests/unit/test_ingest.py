"""Unit tests for the ingest module.

The full happy-path is exercised in the integration test against a real
Weaviate (Task 1.12). Unit tests pin the algorithmic contract:

- UUID5 derivation matches the formula declared in schema.md (idempotent
  re-ingest on CI retry).
- TestRun aggregate fields (status, total_duration_ms, timestamp) derive
  correctly from the parsed cases.
- TestCase batch uses server-side streaming (collection.batch.stream).
- Cross-reference belongsToRun is set on every TestCase.
- Tenacity retries on transient Weaviate errors but not on bugs.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from weaviate_test_reporter.config import Config
from weaviate_test_reporter.ingest import (
    _case_uuid,
    _run_uuid,
    aggregate_run_properties,
    ingest_test_cases,
    insert_test_run,
)
from weaviate_test_reporter.parser import ParsedCase


def _meta(**overrides) -> dict:
    base = {
        "repository": "weaviate/weaviate",
        "workflow_run_id": "12345",
        "workflow_run_attempt": 2,
        "workflow_name": "ci",
        "branch": "main",
        "commit_hash": "abc123",
        "trigger_type": "push",
        "actor": "alice",
        "pr_number": None,
        "run_url": "https://github.com/weaviate/weaviate/actions/runs/12345/attempts/2",
    }
    base.update(overrides)
    return base


def _cfg(**overrides) -> Config:
    kwargs = {
        "weaviate_url": "http://localhost:8080",
        "weaviate_api_key": "",
        "junit_path": "*.xml",
        "job_name": "e2e-backup",
        "fail_on_error": False,
        "vectorizer": "text2vec-weaviate",
        "model2vec_inference_url": "",
        "verbose": False,
    }
    kwargs.update(overrides)
    return Config(**kwargs)


def _case(**overrides) -> ParsedCase:
    base = dict(
        name="test_x",
        test_suite="suite_a",
        framework="pytest",
        status="passed",
        duration_ms=100,
        error_message=None,
        stack_trace=None,
        failure_type=None,
    )
    base.update(overrides)
    return ParsedCase(**base)


# ---------- UUID formulas ----------


def test_run_uuid_is_deterministic_for_same_attempt():
    """Identical (repository, run_id, attempt) -> identical UUID. This is
    the property that makes CI retries idempotent."""
    a = _run_uuid("weaviate/weaviate", "12345", 2)
    b = _run_uuid("weaviate/weaviate", "12345", 2)
    assert a == b
    # Sanity: the result is a valid UUID
    _uuid.UUID(a)


def test_run_uuid_differs_across_attempts():
    """Different attempts of the same run get different UUIDs so retries
    are stored separately (not overwriting attempt 1 with attempt 2)."""
    assert _run_uuid("weaviate/weaviate", "12345", 1) != _run_uuid("weaviate/weaviate", "12345", 2)


def test_case_uuid_includes_full_path():
    """The TestCase UUID must include repo, run, attempt, suite, and name
    so the same logical test in different runs gets distinct UUIDs."""
    a = _case_uuid("repo", "1", 1, "suite", "test_a")
    b = _case_uuid("repo", "1", 1, "suite", "test_b")
    c = _case_uuid("repo", "1", 2, "suite", "test_a")  # different attempt
    assert a != b
    assert a != c


# ---------- aggregate_run_properties ----------


def test_aggregate_status_failure_when_any_case_failed():
    cases = [_case(), _case(status="failed"), _case()]
    meta = _meta()
    cfg = _cfg()
    props = aggregate_run_properties(cases, meta, cfg)
    assert props["status"] == "failure"


def test_aggregate_status_success_when_all_pass_or_skip():
    cases = [_case(), _case(status="skipped"), _case()]
    props = aggregate_run_properties(cases, _meta(), _cfg())
    assert props["status"] == "success"


def test_aggregate_status_success_on_empty_run():
    """An empty test report should not crash and should not be flagged
    as failure — most likely the CI job did not produce any XML, which
    deserves a separate signal (handled in __main__ via a warning log)."""
    props = aggregate_run_properties([], _meta(), _cfg())
    assert props["status"] == "success"
    assert props["total_duration_ms"] == 0


def test_aggregate_total_duration_ms_sums_cases():
    cases = [_case(duration_ms=100), _case(duration_ms=250), _case(duration_ms=50)]
    props = aggregate_run_properties(cases, _meta(), _cfg())
    assert props["total_duration_ms"] == 400


def test_aggregate_carries_github_metadata():
    props = aggregate_run_properties([_case()], _meta(actor="bob"), _cfg())
    assert props["actor"] == "bob"
    assert props["repository"] == "weaviate/weaviate"
    assert props["workflow_run_attempt"] == 2
    assert props["pr_number"] is None


def test_aggregate_timestamp_is_iso_utc():
    """Weaviate's DATE type requires RFC3339; ISO with timezone qualifier
    parses cleanly and survives round-trips."""
    props = aggregate_run_properties([_case()], _meta(), _cfg())
    # Must be parseable by datetime.fromisoformat
    parsed = datetime.fromisoformat(props["timestamp"])
    assert parsed.tzinfo is not None  # must include timezone


def test_aggregate_run_id_is_human_readable_identifier():
    """run_id is the friendly identifier surfaced in the dashboard; it
    must include enough context to disambiguate within a repo."""
    props = aggregate_run_properties(
        [_case()],
        _meta(workflow_name="ci", workflow_run_id="12345", workflow_run_attempt=2),
        _cfg(job_name="e2e-backup"),
    )
    rid = props["run_id"]
    assert "12345" in rid
    assert "e2e-backup" in rid


# ---------- insert_test_run ----------


def test_insert_test_run_first_time_uses_insert():
    """When the UUID is fresh, insert() is the right primitive."""
    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    collection.data.exists.return_value = False

    expected_uuid = _run_uuid("weaviate/weaviate", "12345", 2)
    result_uuid = insert_test_run(client, [_case()], _meta(), _cfg())

    assert result_uuid == expected_uuid
    client.collections.get.assert_called_once_with("TestRun")
    collection.data.exists.assert_called_once_with(uuid=expected_uuid)
    collection.data.insert.assert_called_once()
    collection.data.replace.assert_not_called()
    kwargs = collection.data.insert.call_args.kwargs
    assert kwargs["uuid"] == expected_uuid
    # All required properties must be present
    props = kwargs["properties"]
    for required in (
        "run_id",
        "repository",
        "branch",
        "commit_hash",
        "trigger_type",
        "status",
        "total_duration_ms",
        "timestamp",
        "workflow_run_id",
        "workflow_run_attempt",
        "workflow_name",
        "job_name",
        "actor",
        "run_url",
    ):
        assert required in props, f"missing TestRun property: {required}"


def test_insert_test_run_existing_uuid_uses_replace():
    """When the UUID exists (CI retry), replace() is the upsert primitive.
    This is the contract that prevents 422 errors on idempotent re-runs."""
    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    collection.data.exists.return_value = True

    expected_uuid = _run_uuid("weaviate/weaviate", "12345", 2)
    result_uuid = insert_test_run(client, [_case()], _meta(), _cfg())

    assert result_uuid == expected_uuid
    collection.data.insert.assert_not_called()
    collection.data.replace.assert_called_once()
    kwargs = collection.data.replace.call_args.kwargs
    assert kwargs["uuid"] == expected_uuid
    assert "properties" in kwargs


# ---------- ingest_test_cases (streaming batch + cross-ref) ----------


def test_ingest_test_cases_uses_server_side_streaming_batch():
    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    # The batch context manager must be `collection.batch.stream`.
    batch_ctx = MagicMock()
    collection.batch.stream.return_value.__enter__.return_value = batch_ctx
    collection.batch.failed_objects = []

    cases = [_case(name="t1"), _case(name="t2"), _case(name="t3", status="failed")]
    run_uuid = "00000000-0000-0000-0000-000000000001"

    successful, failed = ingest_test_cases(
        client,
        cases,
        run_uuid,
        repository="weaviate/weaviate",
        workflow_run_id="12345",
        workflow_run_attempt=2,
    )

    collection.batch.stream.assert_called_once()  # NOT fixed_size or dynamic
    assert batch_ctx.add_object.call_count == 3
    assert successful == 3
    assert failed == 0


def test_ingest_test_cases_sets_belongsToRun_cross_reference():
    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    batch_ctx = MagicMock()
    collection.batch.stream.return_value.__enter__.return_value = batch_ctx
    collection.batch.failed_objects = []

    run_uuid = "00000000-0000-0000-0000-000000000001"
    ingest_test_cases(
        client,
        [_case(), _case()],
        run_uuid,
        repository="r",
        workflow_run_id="1",
        workflow_run_attempt=1,
    )

    for call in batch_ctx.add_object.call_args_list:
        refs = call.kwargs["references"]
        assert refs == {"belongsToRun": run_uuid}


def test_ingest_test_cases_uses_deterministic_uuids():
    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    batch_ctx = MagicMock()
    collection.batch.stream.return_value.__enter__.return_value = batch_ctx
    collection.batch.failed_objects = []

    ingest_test_cases(
        client,
        [_case(name="t1", test_suite="s1")],
        "run-uuid",
        repository="r",
        workflow_run_id="1",
        workflow_run_attempt=1,
    )

    uid_arg = batch_ctx.add_object.call_args.kwargs["uuid"]
    expected = _case_uuid("r", "1", 1, "s1", "t1")
    assert uid_arg == expected


def test_ingest_test_cases_counts_failed_objects():
    """When some objects fail server-side validation, the count reflects
    the partial success — this propagates to the action's exit code under
    fail_on_error=true."""
    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    batch_ctx = MagicMock()
    collection.batch.stream.return_value.__enter__.return_value = batch_ctx
    # Two failures reported by the server
    collection.batch.failed_objects = [MagicMock(), MagicMock()]

    successful, failed = ingest_test_cases(
        client,
        [_case(), _case(), _case(), _case(), _case()],
        "ru",
        repository="r",
        workflow_run_id="1",
        workflow_run_attempt=1,
    )
    assert successful == 3
    assert failed == 2


def test_ingest_test_cases_retries_on_connection_error():
    """tenacity should wrap the batch context so a transient Weaviate
    network blip does not require a full CI re-run."""
    from weaviate.exceptions import WeaviateConnectionError

    call_count = {"n": 0}

    def flaky_stream():
        call_count["n"] += 1
        if call_count["n"] < 2:
            raise WeaviateConnectionError("transient")
        return MagicMock(
            __enter__=MagicMock(return_value=MagicMock()),
            __exit__=MagicMock(return_value=False),
        )

    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    collection.batch.stream.side_effect = lambda: flaky_stream()
    collection.batch.failed_objects = []

    # Patch tenacity's wait to make the test fast
    with patch("weaviate_test_reporter.ingest._retry_wait", return_value=0):
        successful, failed = ingest_test_cases(
            client,
            [_case()],
            "ru",
            repository="r",
            workflow_run_id="1",
            workflow_run_attempt=1,
        )

    assert call_count["n"] == 2  # one failure, one success
    assert failed == 0


def test_ingest_test_cases_gives_up_after_max_attempts():
    """A persistent connection failure should propagate (after retries),
    not silently drop the data."""
    from weaviate.exceptions import WeaviateConnectionError

    client = MagicMock()
    collection = MagicMock()
    client.collections.get.return_value = collection
    collection.batch.stream.side_effect = WeaviateConnectionError("down")

    with patch("weaviate_test_reporter.ingest._retry_wait", return_value=0):
        with pytest.raises(WeaviateConnectionError):
            ingest_test_cases(
                client,
                [_case()],
                "ru",
                repository="r",
                workflow_run_id="1",
                workflow_run_attempt=1,
            )
