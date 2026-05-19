"""Idempotent ingestion: TestRun creation + TestCase batch insert.

Idempotency strategy (per .project/02-weaviate-schema.md section 4):

  TestRun UUID  = uuid5(NAMESPACE_URL, "{repo}|{run_id}|{attempt}|{job_name}")
  TestCase UUID = uuid5(NAMESPACE_URL, "{repo}|{run_id}|{attempt}|{job_name}|{suite}|{name}")

`job_name` participates in both UUIDs so that matrix jobs within a single
workflow run (e.g., `replicas` ∈ {1, 3, 7}) produce DISTINCT TestRun rows
and DISTINCT TestCase rows for the same `{suite, name}` pair — otherwise
all matrix cells would clobber each other under the shared `run_id` /
`run_attempt`.

Because the Weaviate v4 client treats matching UUIDs as updates, this
guarantees that re-running the same workflow attempt does not duplicate
data — the most recent run wins.

Batching uses server-side streaming (collection.batch.stream): the server
chooses the batch size and applies back-pressure. See
https://docs.weaviate.io/weaviate/manage-objects/import#server-side-batching
"""

from __future__ import annotations

import uuid as _uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

import weaviate
from tenacity import retry, retry_if_exception_type, stop_after_attempt
from weaviate.exceptions import WeaviateConnectionError

from .config import Config, parse_version
from .logging import get_logger
from .parser import ParsedCase
from .schema import TEST_CASE, TEST_RUN

# ---------- UUID derivation ----------


def _run_uuid(
    repository: str,
    workflow_run_id: str,
    workflow_run_attempt: int,
    job_name: str,
) -> str:
    return str(
        _uuid.uuid5(
            _uuid.NAMESPACE_URL,
            f"{repository}|{workflow_run_id}|{workflow_run_attempt}|{job_name}",
        )
    )


def _case_uuid(
    repository: str,
    workflow_run_id: str,
    workflow_run_attempt: int,
    job_name: str,
    test_suite: str,
    name: str,
) -> str:
    return str(
        _uuid.uuid5(
            _uuid.NAMESPACE_URL,
            f"{repository}|{workflow_run_id}|{workflow_run_attempt}|{job_name}|{test_suite}|{name}",
        )
    )


# ---------- TestRun aggregation ----------


def aggregate_run_properties(
    cases: list[ParsedCase],
    meta: dict[str, Any],
    cfg: Config,
) -> dict[str, Any]:
    """Build the TestRun property bag from parsed cases + GH metadata.

    - status: "failure" if any case failed; "success" otherwise (skipped
      and passed both count as non-failures). Empty runs are "success" — a
      missing XML report is signaled separately in __main__.
    - total_duration_ms: sum across all cases.
    - timestamp: ingest-time UTC (RFC3339-compatible ISO format).
    - run_id: human-readable identifier composed of workflow name, job
      name, run id, and attempt — surfaced in the dashboard.
    """
    any_failed = any(c.status == "failed" for c in cases)
    status = "failure" if any_failed else "success"
    total_duration = sum(c.duration_ms for c in cases)
    now_iso = datetime.now(UTC).isoformat()
    workflow = meta["workflow_name"]
    run_id_friendly = (
        f"{workflow}/{cfg.job_name}#{meta['workflow_run_id']}" f".{meta['workflow_run_attempt']}"
    )

    # Optional artifact version: parsed once here. If the caller fed a
    # non-empty value that's not valid SemVer 2.0, emit one structured
    # warning so the misconfiguration is visible in CI logs — but
    # never raise. Non-version-aware callers stay supported.
    version_full, version_minor = parse_version(cfg.version_under_test)
    if cfg.version_under_test and version_full is None:
        get_logger().warning(
            "malformed_version_under_test",
            value=cfg.version_under_test,
            hint="must be SemVer 2.0 (e.g. 1.37.5, 1.37.5-rc1); "
            "skipping version_full/version_minor population",
        )

    properties: dict[str, Any] = {
        "run_id": run_id_friendly,
        "repository": meta["repository"],
        "branch": meta["branch"],
        "commit_hash": meta["commit_hash"],
        "trigger_type": meta["trigger_type"],
        "status": status,
        "total_duration_ms": total_duration,
        "timestamp": now_iso,
        "workflow_run_id": meta["workflow_run_id"],
        "workflow_run_attempt": meta["workflow_run_attempt"],
        "workflow_name": workflow,
        "job_name": cfg.job_name,
        "pr_number": meta.get("pr_number"),
        "actor": meta["actor"],
        "run_url": meta["run_url"],
    }
    # Only populate the version slots when parsing succeeded. Weaviate
    # accepts missing optional properties on insert/replace; this
    # keeps old rows ingested before the additive migration distinct
    # from rows where the caller deliberately omitted the input.
    if version_full is not None:
        properties["version_full"] = version_full
        properties["version_minor"] = version_minor
    return properties


# ---------- insert_test_run ----------


def insert_test_run(
    client: weaviate.WeaviateClient,
    cases: list[ParsedCase],
    meta: dict[str, Any],
    cfg: Config,
) -> str:
    """Upsert a single TestRun object. Returns the run UUID.

    Weaviate's v4 client splits insert vs replace: insert raises 422 on a
    duplicate UUID, replace requires the UUID to already exist. The
    idempotent ingestion contract demands true upsert, so we check
    exists() and dispatch.
    """
    properties = aggregate_run_properties(cases, meta, cfg)
    run_uuid = _run_uuid(
        meta["repository"],
        meta["workflow_run_id"],
        meta["workflow_run_attempt"],
        cfg.job_name,
    )
    collection = client.collections.get(TEST_RUN)
    if collection.data.exists(uuid=run_uuid):
        collection.data.replace(uuid=run_uuid, properties=properties)
    else:
        collection.data.insert(properties=properties, uuid=run_uuid)
    return run_uuid


# ---------- TestCase batch ingest ----------


# Tenacity wait strategy as a plain function so tests can monkey-patch it
# to return 0 for fast unit tests. Exponential backoff capped at 8s.
def _retry_wait(retry_state: Any) -> float:
    attempt = getattr(retry_state, "attempt_number", 1)
    return min(2**attempt, 8)


def _case_properties(c: ParsedCase) -> dict[str, Any]:
    return {
        "name": c.name,
        "test_suite": c.test_suite,
        "framework": c.framework,
        "status": c.status,
        "duration_ms": c.duration_ms,
        "error_message": c.error_message,
        "stack_trace": c.stack_trace,
        "failure_type": c.failure_type,
    }


@retry(
    stop=stop_after_attempt(3),
    wait=_retry_wait,
    retry=retry_if_exception_type(WeaviateConnectionError),
    reraise=True,
)
def ingest_test_cases(
    client: weaviate.WeaviateClient,
    cases: Iterable[ParsedCase],
    run_uuid: str,
    repository: str,
    workflow_run_id: str,
    workflow_run_attempt: int,
    job_name: str,
) -> tuple[int, int]:
    """Server-side streaming batch insert. Returns (successful, failed).

    Re-uses the parent run UUID as the belongsToRun cross-reference for
    every TestCase so downstream queries can fetch all cases of a run in
    a single hop.
    """
    collection = client.collections.get(TEST_CASE)
    submitted = 0
    with collection.batch.stream() as batch:
        for c in cases:
            uid = _case_uuid(
                repository,
                workflow_run_id,
                workflow_run_attempt,
                job_name,
                c.test_suite,
                c.name,
            )
            batch.add_object(
                properties=_case_properties(c),
                uuid=uid,
                references={"belongsToRun": run_uuid},
            )
            submitted += 1
    failed = len(collection.batch.failed_objects)
    return submitted - failed, failed
