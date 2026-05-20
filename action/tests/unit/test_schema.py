"""Unit tests for the schema module.

Guards the property catalog, the per-property index flags, named-vector
hookup, and idempotency. End-to-end correctness against a real Weaviate
is verified in the integration suite.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import weaviate.classes.config as wvcc

from weaviate_test_reporter.schema import (
    TEST_CASE,
    TEST_RUN,
    ensure_test_case_collection,
    ensure_test_case_properties,
    ensure_test_run_collection,
    ensure_test_run_properties,
)
from weaviate_test_reporter.vectorization import (
    NAMED_VECTOR_PROPERTIES,
    build_test_case_vector_config,
)

# ---------- contract: collection names ----------


def test_collection_names_match_schema_doc():
    assert TEST_RUN == "TestRun"
    assert TEST_CASE == "TestCase"


# ---------- TestRun ----------


def test_ensure_test_run_creates_when_missing():
    client = MagicMock()
    client.collections.exists.return_value = False

    ensure_test_run_collection(client)

    client.collections.exists.assert_called_once_with(TEST_RUN)
    client.collections.create.assert_called_once()
    kwargs = client.collections.create.call_args.kwargs
    assert kwargs["name"] == TEST_RUN
    # TestRun has no vector_config — it is filterable/aggregatable only.
    assert "vector_config" not in kwargs or kwargs["vector_config"] is None

    prop_names = {p.name for p in kwargs["properties"]}
    expected = {
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
        "pr_number",
        "actor",
        "run_url",
        "version_full",
        "version_patch",
        "version_minor",
    }
    assert prop_names == expected


def test_test_run_index_flags_are_explicit():
    """Every property must have index_filterable set explicitly — no
    relying on v4 defaults. This catches accidental regressions where a
    new property is added without thinking through its index footprint.
    """
    client = MagicMock()
    client.collections.exists.return_value = False
    ensure_test_run_collection(client)
    props = {p.name: p for p in client.collections.create.call_args.kwargs["properties"]}

    # Filterable — these power filter / aggregate queries.
    for f in (
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
        "pr_number",
        "actor",
    ):
        assert props[f].indexFilterable is True, f"{f} should be filterable"

    # Display-only.
    assert props["run_url"].indexFilterable is False
    assert props["run_url"].indexSearchable is False

    # Range filterable (numeric + date — for "slowest" and "since" queries).
    for r in (
        "total_duration_ms",
        "timestamp",
        "workflow_run_attempt",
        "pr_number",
    ):
        assert props[r].indexRangeFilters is True, f"{r} should be range-filterable"


def test_ensure_test_run_is_idempotent_when_present():
    client = MagicMock()
    client.collections.exists.return_value = True
    ensure_test_run_collection(client)
    client.collections.exists.assert_called_once_with(TEST_RUN)
    client.collections.create.assert_not_called()


def test_ensure_test_run_enables_index_timestamps():
    client = MagicMock()
    client.collections.exists.return_value = False
    ensure_test_run_collection(client)
    inverted = client.collections.create.call_args.kwargs["inverted_index_config"]
    assert getattr(inverted, "indexTimestamps", None) is True


# ---------- TestCase ----------


def test_ensure_test_case_creates_with_named_vector_config():
    client = MagicMock()
    client.collections.exists.return_value = False
    vector_config = build_test_case_vector_config("text2vec-model2vec", "http://m2v:8080")

    ensure_test_case_collection(client, vector_config=vector_config)

    kwargs = client.collections.create.call_args.kwargs
    assert kwargs["name"] == TEST_CASE
    # Three named vectors, one per high-signal property.
    assert isinstance(kwargs["vector_config"], list)
    assert len(kwargs["vector_config"]) == len(NAMED_VECTOR_PROPERTIES)

    prop_names = {p.name for p in kwargs["properties"]}
    expected = {
        "name",
        "test_suite",
        "framework",
        "status",
        "duration_ms",
        "error_message",
        "stack_trace",
        "failure_type",
    }
    assert prop_names == expected


def test_test_case_index_flags_match_schema_doc():
    client = MagicMock()
    client.collections.exists.return_value = False
    ensure_test_case_collection(client, vector_config=None)
    props = {p.name: p for p in client.collections.create.call_args.kwargs["properties"]}

    # Vectorized text bodies are searchable (BM25 fallback) but NOT filterable.
    for v in ("name", "error_message", "stack_trace"):
        assert props[v].indexSearchable is True, f"{v} should be BM25-searchable"
        assert props[v].indexFilterable is False, f"{v} should not be filterable"
        assert props[v].skip_vectorization is False, f"{v} must source a vector"

    # Filterable text fields opt OUT of vectorization.
    for f in ("test_suite", "framework", "status", "failure_type"):
        assert props[f].indexFilterable is True, f"{f} should be filterable"
        assert props[f].indexSearchable is False, f"{f} should not be searchable"
        assert props[f].skip_vectorization is True

    # duration_ms is filterable + range-filterable for "slowest tests" queries.
    assert props["duration_ms"].indexFilterable is True
    assert props["duration_ms"].indexRangeFilters is True


def test_ensure_test_case_can_disable_vectorization():
    """vector_config=None creates the collection without any vector slot
    — useful for filter-only deployments / dev / tests."""
    client = MagicMock()
    client.collections.exists.return_value = False
    ensure_test_case_collection(client, vector_config=None)
    kwargs = client.collections.create.call_args.kwargs
    assert kwargs["vector_config"] is None


def test_ensure_test_case_declares_belongsToRun_cross_reference():
    client = MagicMock()
    client.collections.exists.return_value = False
    ensure_test_case_collection(client, vector_config=None)
    references = client.collections.create.call_args.kwargs["references"]
    assert len(references) == 1
    assert references[0].name == "belongsToRun"
    assert references[0].target_collection == TEST_RUN


def test_ensure_test_case_enables_index_timestamps():
    client = MagicMock()
    client.collections.exists.return_value = False
    ensure_test_case_collection(client, vector_config=None)
    inverted = client.collections.create.call_args.kwargs["inverted_index_config"]
    assert getattr(inverted, "indexTimestamps", None) is True


def test_ensure_test_case_is_idempotent_when_present():
    client = MagicMock()
    client.collections.exists.return_value = True
    ensure_test_case_collection(client, vector_config=None)
    client.collections.create.assert_not_called()


# ---------- vectorization builder ----------


def test_build_vector_config_none_returns_none():
    assert build_test_case_vector_config("none") is None


def test_build_vector_config_text2vec_weaviate():
    cfg = build_test_case_vector_config("text2vec-weaviate")
    assert cfg is not None
    names = {getattr(v, "name", None) for v in cfg}
    assert names == set(NAMED_VECTOR_PROPERTIES)


def test_build_vector_config_text2vec_model2vec():
    cfg = build_test_case_vector_config("text2vec-model2vec", "http://m2v:8080")
    assert cfg is not None
    names = {getattr(v, "name", None) for v in cfg}
    assert names == set(NAMED_VECTOR_PROPERTIES)


def test_build_vector_config_model2vec_requires_inference_url():
    import pytest as _pytest

    from weaviate_test_reporter.vectorization import UnknownVectorizerError

    with _pytest.raises(UnknownVectorizerError):
        build_test_case_vector_config("text2vec-model2vec", "")


def test_build_vector_config_rejects_unknown_vectorizer():
    import pytest as _pytest

    from weaviate_test_reporter.vectorization import UnknownVectorizerError

    with _pytest.raises(UnknownVectorizerError):
        build_test_case_vector_config("davinci-2000")


# ---------- additive migration: ensure_test_run_properties ----------


def _mock_existing_collection(existing_property_names: set[str]):
    """Build a (client, collection) mock pair where the collection
    reports a config with the given existing properties."""
    client = MagicMock()
    client.collections.exists.return_value = True
    collection = MagicMock()
    client.collections.get.return_value = collection
    # collection.config.get().properties -> list of objects with .name
    fake_props = [MagicMock(name=f"prop_{n}") for n in existing_property_names]
    for fp, n in zip(fake_props, existing_property_names, strict=True):
        fp.name = n
    collection.config.get.return_value.properties = fake_props
    return client, collection


def test_ensure_test_run_properties_adds_missing_version_props():
    """The TestRun collection pre-dates the version-* properties — the
    migration must add all three via `collection.config.add_property`."""
    pre_migration = {
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
        "pr_number",
        "actor",
        "run_url",
    }
    client, collection = _mock_existing_collection(pre_migration)

    ensure_test_run_properties(client)

    assert collection.config.add_property.call_count == 3
    added_names = {call.args[0].name for call in collection.config.add_property.call_args_list}
    assert added_names == {"version_full", "version_patch", "version_minor"}


def test_ensure_test_run_properties_adds_only_version_patch_when_others_present():
    """Simulates the migration path on clusters that shipped the
    earlier `version_full` / `version_minor` schema (PR #5) but not
    `version_patch` — only the new slot is added, the existing two
    are left untouched."""
    pre_patch = {
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
        "pr_number",
        "actor",
        "run_url",
        "version_full",
        "version_minor",
    }
    client, collection = _mock_existing_collection(pre_patch)

    ensure_test_run_properties(client)

    assert collection.config.add_property.call_count == 1
    added_names = {call.args[0].name for call in collection.config.add_property.call_args_list}
    assert added_names == {"version_patch"}


def test_ensure_test_run_properties_is_idempotent():
    """When every property in the spec is already on the collection,
    `add_property` must not be called."""
    full_spec_names = {
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
        "pr_number",
        "actor",
        "run_url",
        "version_full",
        "version_patch",
        "version_minor",
    }
    client, collection = _mock_existing_collection(full_spec_names)

    ensure_test_run_properties(client)

    collection.config.add_property.assert_not_called()


def test_ensure_test_run_properties_no_op_when_collection_missing():
    """Defensive: if the collection doesn't exist (ordering bug), the
    function silently returns rather than 404-ing on `collections.get`."""
    client = MagicMock()
    client.collections.exists.return_value = False

    ensure_test_run_properties(client)

    client.collections.get.assert_not_called()


def test_ensure_test_case_properties_is_idempotent_on_current_spec():
    """No new TestCase props in this migration — `add_property` must
    not be called when the live collection already has the full spec.
    The function exists so future additive changes inherit the path."""
    full_case_spec_names = {
        "name",
        "test_suite",
        "framework",
        "status",
        "duration_ms",
        "error_message",
        "stack_trace",
        "failure_type",
    }
    client, collection = _mock_existing_collection(full_case_spec_names)

    ensure_test_case_properties(client)

    collection.config.add_property.assert_not_called()


# Silence unused-import lint when wvcc isn't directly referenced.
_ = wvcc
