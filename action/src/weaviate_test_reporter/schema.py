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

# ---------------------------------------------------------------------------
# Descriptions.
#
# The Weaviate Query Agent reads collection + property descriptions from the
# schema to decide which collection/property to search, filter, or aggregate.
# Without them it has to guess, which produces flaky / incomplete answers
# (e.g. failing to filter by `status` or group by `name`). Keep these concise
# but explicit about VALUES (the exact `status` strings) and intended use.
#
# NB: these are applied on CREATE and when a NEW property is added. They are
# NOT back-filled onto properties that already exist on a live collection —
# update those in the Weaviate console (see .project/02-weaviate-schema.md).
# ---------------------------------------------------------------------------

_TEST_RUN_DESCRIPTION = (
    "A single CI test-run execution (one GitHub Actions job run) of a test "
    "suite against a specific Weaviate version. Use for run-level questions: "
    "pass/fail rates, durations, which versions / repositories / branches were "
    "tested, and trends over time. Each TestCase links to its run via the "
    "belongsToRun reference."
)

_TEST_RUN_DESCRIPTIONS: dict[str, str] = {
    "run_id": (
        "Unique id of the CI run (composite of workflow, job and run number), "
        "e.g. 'ci/e2e-backup#12345.1'."
    ),
    "repository": "GitHub repository the run belongs to, e.g. 'weaviate/weaviate'.",
    "branch": "Git branch the run executed against, e.g. 'main'.",
    "commit_hash": "Full git commit SHA the run tested.",
    "trigger_type": (
        "How the run was triggered: one of 'pull_request', 'push', 'schedule', "
        "'workflow_dispatch'."
    ),
    "status": (
        "Outcome of the whole run. One of 'success' or 'failure'. Filter "
        "status='failure' for failed runs; run-level pass rate = success runs "
        "/ total runs."
    ),
    "total_duration_ms": "Total wall-clock duration of the run, in milliseconds.",
    "timestamp": (
        "When the run started (RFC3339 date-time). Use for time-window filters "
        "like 'last 7 days' and for chronological ordering."
    ),
    "workflow_run_id": "GitHub Actions workflow run id.",
    "workflow_run_attempt": "Attempt number of the workflow run; increments on re-runs / retries.",
    "workflow_name": "Name of the GitHub Actions workflow.",
    "job_name": "Logical job name within the workflow.",
    "pr_number": (
        "Pull-request number when the run was triggered by a pull_request, " "otherwise null."
    ),
    "actor": "GitHub username that triggered the run.",
    "run_url": "Link to the run on GitHub (display only).",
    "job_url": (
        "Deep-link to this run's specific CI job on GitHub (display only). "
        "Falls back to the run+attempt page (run_url) when the per-job URL "
        "can't be resolved."
    ),
    "version_full": (
        "Exact Weaviate build under test incl. pre-release/build suffix, e.g. "
        "'1.38.1-rfea1de'. Use for exact-build dedup. Null when no version was "
        "supplied."
    ),
    "version_patch": (
        "Canonical Weaviate release MAJOR.MINOR.PATCH, e.g. '1.38.1'. Group by "
        "this for per-release rollups. Null when no version was supplied."
    ),
    "version_minor": (
        "Weaviate MAJOR.MINOR lineage, e.g. '1.38'. Primary key for grouping "
        "runs by version line. Null when no version was supplied."
    ),
    "started_at": (
        "Real run start (RFC3339 date-time) from the JUnit <testsuite "
        "timestamp>; falls back to ingest time when no suite emitted one. "
        "Prefer this over 'timestamp' for 'last N days' windows and trends."
    ),
    "tests_total": (
        "Total tests executed in the run (sum of <testsuite tests>). Baseline "
        "for pass rate and 'expected vs executed' checks."
    ),
    "tests_passed": (
        "Tests that passed: total - failed - errors - skipped (floored at 0). "
        "Test-level pass rate = tests_passed / tests_total (distinct from the "
        "run-level pass rate, which is successful runs / total runs)."
    ),
    "tests_failed": "Tests that failed assertions (sum of <testsuite failures>).",
    "tests_skipped": "Tests skipped / not run (sum of <testsuite skipped>).",
    "tests_errors": (
        "Tests that errored out (setup / runtime errors, sum of <testsuite "
        "errors>); distinct from assertion failures."
    ),
}

_TEST_CASE_DESCRIPTION = (
    "An individual test-case result within a CI run (one test function / "
    "assertion). Captures whether a single test passed, failed, or was "
    "skipped, plus its error output. Linked to its parent run via the "
    "belongsToRun reference. Use for test-level questions: which tests fail "
    "most often, flaky tests, failures by suite, and semantic search over "
    "errors / stack traces (vectorized on name, error_message, stack_trace)."
)

_TEST_CASE_DESCRIPTIONS: dict[str, str] = {
    "name": (
        "The test's name / identifier (function or parametrized id), e.g. "
        "'test_backup_restore[s3]'. Group by this to find which tests fail most often."
    ),
    "test_suite": "Module / suite / package the test belongs to, e.g. 'tests.e2e.test_backup'.",
    "framework": "Testing framework that produced the result: 'pytest', 'golang' or 'unknown'.",
    "status": (
        "Outcome of this test. One of 'passed', 'failed' or 'skipped'. "
        "Filter status='failed' to find failures."
    ),
    "duration_ms": "Test execution time, in milliseconds.",
    "error_message": (
        "One-line failure summary / assertion message; empty when the test "
        "passed. Vectorized for semantic search."
    ),
    "stack_trace": (
        "Full failure traceback; empty when the test passed. Vectorized for "
        "semantic search — best for matching failure shapes."
    ),
    "failure_type": (
        "Category of the failure, e.g. 'AssertionError', 'TimeoutError'; null "
        "when the test passed."
    ),
    "run_started_at": (
        "Real start time of the parent run (RFC3339), denormalized from "
        "TestRun.started_at. Filter time windows ('last 7 days') directly on "
        "TestCase — no need to hop through belongsToRun."
    ),
    "retry_count": (
        "Number of rerun / flaky attempts recorded for this test in the run "
        "(0 when the framework reported no retries)."
    ),
    "passed_on_retry": (
        "True when the test failed at least once then passed within the same "
        "run — the authoritative single-run flake signal. False otherwise."
    ),
    "initial_status": (
        "First-attempt outcome: 'failed' when the test was retried, otherwise "
        "equal to 'status'. Compare with 'status' to spot recovered flakes."
    ),
    "failure_fingerprint": (
        "Stable hash of the normalized stack trace (line numbers / addresses / "
        "timestamps / temp paths stripped). Group by it to cluster identical "
        "failures; null for passed / skipped tests."
    ),
}

_BELONGS_TO_RUN_DESCRIPTION = (
    "Reference to the parent TestRun this case belongs to. Follow it to relate "
    "a test case to its run's version, branch, repository and timestamp."
)

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
    ("job_url", wvcc.DataType.TEXT, False, False, False),
    # Three version slots, all derived from the single `version_under_test`
    # action input via `config.parse_version`. The slots progress from
    # most-specific to most-aggregable:
    #
    #   - `version_full`  = the build identifier including pre-release /
    #     build-metadata suffix (e.g., "1.38.1-rfea1de"). Use this for
    #     exact-build deduplication ("did we already test this build?").
    #   - `version_patch` = canonical SemVer release with pre-release
    #     dropped (e.g., "1.38.1"). Dashboard's "Patches" rollup.
    #   - `version_minor` = MAJOR.MINOR lineage (e.g., "1.38"). The
    #     primary grouping key on the Versions page.
    #
    # All three are populated when `version_under_test` parses as SemVer
    # 2.0; null on rows from non-version-aware callers. The action
    # raises a hard ConfigError if a non-empty `version_under_test`
    # fails to parse — strict-by-default, no silent skip. Filterable
    # so the dashboard can group / aggregate per slot. See
    # `.project/02-weaviate-schema.md` §6 for the additive-schema
    # migration policy that makes adding these safe on existing
    # TestRun collections.
    ("version_full", wvcc.DataType.TEXT, True, False, False),
    ("version_patch", wvcc.DataType.TEXT, True, False, False),
    ("version_minor", wvcc.DataType.TEXT, True, False, False),
    # WS1 D1/D2 additions (see .project/06-product-roadmap.md §2 and the
    # additive-migration policy in .project/02-weaviate-schema.md §6).
    #   - started_at (DATE): real run start from <testsuite timestamp>;
    #     range-filterable so "last 7 days" windows sort/filter correctly.
    #   - tests_* (INT): run-level counts from the <testsuite> summary
    #     attributes; range-filterable for pass-rate / threshold queries.
    ("started_at", wvcc.DataType.DATE, True, False, True),
    ("tests_total", wvcc.DataType.INT, True, False, True),
    ("tests_passed", wvcc.DataType.INT, True, False, True),
    ("tests_failed", wvcc.DataType.INT, True, False, True),
    ("tests_skipped", wvcc.DataType.INT, True, False, True),
    ("tests_errors", wvcc.DataType.INT, True, False, True),
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
    # WS1 D1/D3/D4 additions. All are filter/aggregate signals — none feed a
    # named vector, so skip_vectorization=True throughout.
    #   - run_started_at (DATE): denormalized run start for direct time-window
    #     filtering on TestCase (range-filterable).
    #   - retry_count (INT): rerun/flaky attempts (range-filterable).
    #   - passed_on_retry (BOOL): confirmed single-run flake (no range index).
    #   - initial_status (TEXT): first-attempt outcome.
    #   - failure_fingerprint (TEXT): normalized-trace dedup key; exact-match
    #     filter only (not BM25-searchable).
    ("run_started_at", wvcc.DataType.DATE, True, False, True, True),
    ("retry_count", wvcc.DataType.INT, True, False, True, True),
    ("passed_on_retry", wvcc.DataType.BOOL, True, False, False, True),
    ("initial_status", wvcc.DataType.TEXT, True, False, False, True),
    ("failure_fingerprint", wvcc.DataType.TEXT, True, False, False, True),
]


def _build_property(
    name: str,
    data_type: wvcc.DataType,
    filterable: bool,
    searchable: bool,
    range_filters: bool,
    skip_vectorization: bool | None = None,
    description: str | None = None,
) -> wvcc.Property:
    kwargs: dict[str, Any] = {
        "name": name,
        "data_type": data_type,
        "index_filterable": filterable,
        "index_range_filters": range_filters if range_filters else None,
    }
    if description:
        kwargs["description"] = description
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
        _build_property(
            name,
            dt,
            filt,
            search,
            rng,
            description=_TEST_RUN_DESCRIPTIONS.get(name),
        )
        for (name, dt, filt, search, rng) in _TEST_RUN_PROPERTY_SPEC
    ]


def _test_case_properties() -> list[wvcc.Property]:
    return [
        _build_property(
            name,
            dt,
            filt,
            search,
            rng,
            skip_vec,
            description=_TEST_CASE_DESCRIPTIONS.get(name),
        )
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
        description=_TEST_RUN_DESCRIPTION,
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
        description=_TEST_CASE_DESCRIPTION,
        vector_config=vector_config,
        inverted_index_config=wvcc.Configure.inverted_index(index_timestamps=True),
        properties=_test_case_properties(),
        references=[
            wvcc.ReferenceProperty(
                name="belongsToRun",
                target_collection=TEST_RUN,
                description=_BELONGS_TO_RUN_DESCRIPTION,
            ),
        ],
    )


def ensure_test_run_properties(client: weaviate.WeaviateClient) -> None:
    """Additive migration: add any properties in the spec that are
    missing on the existing TestRun collection.

    Called at action startup AFTER `ensure_test_run_collection`. Lets us
    extend the schema (new optional properties) without dropping data
    on the live WCD instance. Idempotent — no-op when every property
    in the spec is already present on the collection. Defensive no-op
    when the collection doesn't yet exist (ordering bug guard).

    Schema evolution policy (.project/02-weaviate-schema.md §6):
    additive changes are free; renames / type changes require a
    dual-write window or stop-the-world reingest.
    """
    if not client.collections.exists(TEST_RUN):
        return
    collection = client.collections.get(TEST_RUN)
    existing = {p.name for p in collection.config.get().properties}
    for spec in _TEST_RUN_PROPERTY_SPEC:
        name = spec[0]
        if name in existing:
            continue
        collection.config.add_property(
            _build_property(*spec, description=_TEST_RUN_DESCRIPTIONS.get(name))
        )


def ensure_test_case_properties(client: weaviate.WeaviateClient) -> None:
    """Mirror of `ensure_test_run_properties` for TestCase. No new
    properties today, but the function exists so future TestCase spec
    extensions inherit the same idempotent additive-migration path.
    """
    if not client.collections.exists(TEST_CASE):
        return
    collection = client.collections.get(TEST_CASE)
    existing = {p.name for p in collection.config.get().properties}
    for spec in _TEST_CASE_PROPERTY_SPEC:
        name = spec[0]
        if name in existing:
            continue
        collection.config.add_property(
            _build_property(*spec, description=_TEST_CASE_DESCRIPTIONS.get(name))
        )
