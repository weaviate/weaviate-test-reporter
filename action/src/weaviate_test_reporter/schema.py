"""Weaviate collection definitions for TestRun and TestCase.

This module is the single source of truth on the Python side for what the
Weaviate schema must look like. It MUST stay in lock-step with
.project/02-weaviate-schema.md — the unit tests in test_schema.py guard
that contract.

Design choices:
- Vectorization is configurable via `vector_config` (see vectorization.py).
  TestCase ships THREE named vectors by default — name / error_message /
  stack_trace — so the dashboard can target the slot best suited to a
  query shape.
- index_filterable / index_searchable / index_range_filters are set
  explicitly per property (no v4 defaults). Filterable for properties we
  filter or aggregate by; searchable only for BM25-relevant text bodies.
- index_timestamps=True on both collections so TTL/retention can be
  enabled at any time without re-indexing.
- TestRun: no vectorizer. It is purely filterable / aggregatable; the
  semantic weight lives on TestCase.
- ensure_*_collection() is idempotent: it checks collections.exists()
  before calling create(), so repeated runs are safe.
"""

from __future__ import annotations

from typing import Any

import weaviate
import weaviate.classes.config as wvcc

TEST_RUN = "TestRun"
TEST_CASE = "TestCase"

# (name, data_type, filterable, searchable, range_filters)
# searchable is meaningful for TEXT only — NB tracks per-property indexes.
_TEST_RUN_PROPERTY_SPEC: list[tuple[str, wvcc.DataType, bool, bool, bool]] = [
    ("run_id", wvcc.DataType.TEXT, True, False, False),
    ("repository", wvcc.DataType.TEXT, True, False, False),
    ("branch", wvcc.DataType.TEXT, True, False, False),
    ("commit_hash", wvcc.DataType.TEXT, True, False, False),
    ("trigger_type", wvcc.DataType.TEXT, True, False, False),
    ("status", wvcc.DataType.TEXT, True, False, False),
    ("total_duration_ms", wvcc.DataType.INT, True, False, True),
    ("timestamp", wvcc.DataType.DATE, True, False, True),
    ("workflow_run_id", wvcc.DataType.TEXT, True, False, False),
    ("workflow_run_attempt", wvcc.DataType.INT, True, False, True),
    ("workflow_name", wvcc.DataType.TEXT, True, False, False),
    ("job_name", wvcc.DataType.TEXT, True, False, False),
    ("pr_number", wvcc.DataType.INT, True, False, True),
    ("actor", wvcc.DataType.TEXT, True, False, False),
    # Display-only — no need to index.
    ("run_url", wvcc.DataType.TEXT, False, False, False),
]

# TestCase: (name, data_type, filterable, searchable, range_filters, skip_vectorization)
# - skip_vectorization=False for properties that source a named vector.
# - searchable=True for the vectorized text bodies (gives BM25 fallback).
_TEST_CASE_PROPERTY_SPEC: list[tuple[str, wvcc.DataType, bool, bool, bool, bool]] = [
    ("name", wvcc.DataType.TEXT, False, True, False, False),
    ("test_suite", wvcc.DataType.TEXT, True, False, False, True),
    ("framework", wvcc.DataType.TEXT, True, False, False, True),
    ("status", wvcc.DataType.TEXT, True, False, False, True),
    ("duration_ms", wvcc.DataType.INT, True, False, True, False),
    ("error_message", wvcc.DataType.TEXT, False, True, False, False),
    ("stack_trace", wvcc.DataType.TEXT, False, True, False, False),
    ("failure_type", wvcc.DataType.TEXT, True, False, False, True),
]


def _build_property(
    name: str,
    data_type: wvcc.DataType,
    filterable: bool,
    searchable: bool,
    range_filters: bool,
    skip_vectorization: bool | None = None,
) -> wvcc.Property:
    kwargs: dict[str, Any] = {
        "name": name,
        "data_type": data_type,
        "index_filterable": filterable,
        "index_range_filters": range_filters if range_filters else None,
    }
    # Only TEXT properties have a searchable inverted index.
    if data_type == wvcc.DataType.TEXT:
        kwargs["index_searchable"] = searchable
    if skip_vectorization is not None:
        kwargs["skip_vectorization"] = skip_vectorization
    # Drop None-valued kwargs so the client uses its defaults for
    # properties (e.g., INT) where the option doesn't apply.
    return wvcc.Property(**{k: v for k, v in kwargs.items() if v is not None})


def _test_run_properties() -> list[wvcc.Property]:
    return [
        _build_property(name, dt, filt, search, rng)
        for (name, dt, filt, search, rng) in _TEST_RUN_PROPERTY_SPEC
    ]


def _test_case_properties() -> list[wvcc.Property]:
    return [
        _build_property(name, dt, filt, search, rng, skip_vec)
        for (name, dt, filt, search, rng, skip_vec) in _TEST_CASE_PROPERTY_SPEC
    ]


def ensure_test_run_collection(client: weaviate.WeaviateClient) -> None:
    """Create the TestRun collection if it does not yet exist. Idempotent.

    No vector_config — TestRun is filterable / aggregatable only.
    """
    if client.collections.exists(TEST_RUN):
        return
    client.collections.create(
        name=TEST_RUN,
        inverted_index_config=wvcc.Configure.inverted_index(index_timestamps=True),
        properties=_test_run_properties(),
    )


def ensure_test_case_collection(
    client: weaviate.WeaviateClient,
    vector_config: list[Any] | None = None,
) -> None:
    """Create the TestCase collection if it does not yet exist. Idempotent.

    `vector_config` is the v4 named-vector configuration produced by
    `vectorization.build_test_case_vector_config(...)`. Pass `None` to
    create the collection without any vectorization (useful for tests
    or filter-only deployments).
    """
    if client.collections.exists(TEST_CASE):
        return
    client.collections.create(
        name=TEST_CASE,
        vector_config=vector_config,
        inverted_index_config=wvcc.Configure.inverted_index(index_timestamps=True),
        properties=_test_case_properties(),
        references=[
            wvcc.ReferenceProperty(name="belongsToRun", target_collection=TEST_RUN),
        ],
    )
