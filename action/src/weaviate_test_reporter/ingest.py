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
from .parser import ParsedCase, RunSummary
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


def resolve_run_started_at(summary: RunSummary | None, ingest_now: str | None = None) -> str:
    """The run's real start time (WS1 D1) as an ISO string.

    Prefers the earliest `<testsuite timestamp>` captured in the parsed summary.
    When no suite emitted one, falls back to `ingest_now` if supplied (so the
    caller can share ONE ingest clock across started_at + timestamp, making them
    identical for dateless dialects) — otherwise a fresh now(UTC). Computed once
    per run so TestRun.started_at and every denormalized TestCase.run_started_at
    agree.
    """
    if summary is not None and summary.started_at is not None:
        return summary.started_at.isoformat()
    return ingest_now if ingest_now is not None else datetime.now(UTC).isoformat()


def _resolve_counts(cases: list[ParsedCase], summary: RunSummary | None) -> dict[str, int]:
    """Run-level counts (WS1 D2). Prefers the <testsuite> summary attributes;
    falls back to counting parsed cases by status so the fields are always
    populated. `tests_passed` is derived and floored at 0."""
    if summary is not None:
        total = summary.tests_total
        failed = summary.tests_failed
        errors = summary.tests_errors
        skipped = summary.tests_skipped
    else:
        total = len(cases)
        # At parse time <error> is folded into "failed"; without the suite
        # attributes we can't split it back out, so errors stays 0.
        failed = sum(1 for c in cases if c.status == "failed")
        errors = 0
        skipped = sum(1 for c in cases if c.status == "skipped")
    passed = max(0, total - failed - errors - skipped)
    return {
        "tests_total": total,
        "tests_passed": passed,
        "tests_failed": failed,
        "tests_skipped": skipped,
        "tests_errors": errors,
    }


def aggregate_run_properties(
    cases: list[ParsedCase],
    meta: dict[str, Any],
    cfg: Config,
    summary: RunSummary | None = None,
    run_started_at: str | None = None,
    ingest_now: str | None = None,
) -> dict[str, Any]:
    """Build the TestRun property bag from parsed cases + GH metadata.

    - status: "failure" if any case failed; "success" otherwise (skipped
      and passed both count as non-failures). Empty runs are "success" — a
      missing XML report is signaled separately in __main__.
    - total_duration_ms: sum across all cases.
    - timestamp: ingest-time UTC (RFC3339-compatible ISO format). Kept as
      ingest time for backward compatibility — NOT repurposed to run-start.
    - started_at (WS1 D1): real run start from the JUnit summary, falling
      back to ingest time when no suite emitted a timestamp.
    - tests_* (WS1 D2): run-level counts from the JUnit summary attributes.
    - run_id: human-readable identifier composed of workflow name, job
      name, run id, and attempt — surfaced in the dashboard.
    """
    any_failed = any(c.status == "failed" for c in cases)
    status = "failure" if any_failed else "success"
    total_duration = sum(c.duration_ms for c in cases)
    now_iso = ingest_now if ingest_now is not None else datetime.now(UTC).isoformat()
    if run_started_at is not None:
        started_at = run_started_at
    elif summary is not None and summary.started_at is not None:
        started_at = summary.started_at.isoformat()
    else:
        # No caller-supplied start and no suite timestamp: started_at mirrors
        # the ingest timestamp exactly (3-arg back-compat / dateless dialect).
        started_at = now_iso
    workflow = meta["workflow_name"]
    run_id_friendly = (
        f"{workflow}/{cfg.job_name}#{meta['workflow_run_id']}" f".{meta['workflow_run_attempt']}"
    )

    # Optional artifact version. `Config.from_env` already raised if a
    # non-empty `version_under_test` failed to parse, so by the time we
    # land here either (a) the input was empty (all-None) or (b) all
    # three slots are populated. No warn path; the misconfiguration
    # case fails fast at config-load.
    version_full, version_patch, version_minor = parse_version(cfg.version_under_test)

    properties: dict[str, Any] = {
        "run_id": run_id_friendly,
        "repository": meta["repository"],
        "branch": meta["branch"],
        "commit_hash": meta["commit_hash"],
        "trigger_type": meta["trigger_type"],
        "status": status,
        "total_duration_ms": total_duration,
        "timestamp": now_iso,
        "started_at": started_at,
        "workflow_run_id": meta["workflow_run_id"],
        "workflow_run_attempt": meta["workflow_run_attempt"],
        "workflow_name": workflow,
        "job_name": cfg.job_name,
        "pr_number": meta.get("pr_number"),
        "actor": meta["actor"],
        "run_url": meta["run_url"],
        **_resolve_counts(cases, summary),
    }
    # Only populate the version slots when parsing succeeded. Weaviate
    # accepts missing optional properties on insert/replace; this
    # keeps old rows ingested before the additive migration distinct
    # from rows where the caller deliberately omitted the input.
    if version_full is not None:
        properties["version_full"] = version_full
        properties["version_patch"] = version_patch
        properties["version_minor"] = version_minor
    return properties


# ---------- insert_test_run ----------


def insert_test_run(
    client: weaviate.WeaviateClient,
    cases: list[ParsedCase],
    meta: dict[str, Any],
    cfg: Config,
    summary: RunSummary | None = None,
    run_started_at: str | None = None,
    ingest_now: str | None = None,
) -> str:
    """Upsert a single TestRun object. Returns the run UUID.

    Weaviate's v4 client splits insert vs replace: insert raises 422 on a
    duplicate UUID, replace requires the UUID to already exist. The
    idempotent ingestion contract demands true upsert, so we check
    exists() and dispatch.

    `summary` (WS1 D1/D2) supplies the real run-start timestamp and the
    run-level counts; `run_started_at` lets the caller pin the exact ISO
    value it also denormalizes onto every TestCase.
    """
    properties = aggregate_run_properties(
        cases, meta, cfg, summary=summary, run_started_at=run_started_at, ingest_now=ingest_now
    )
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


def _case_properties(c: ParsedCase, run_started_at: str | None = None) -> dict[str, Any]:
    props: dict[str, Any] = {
        "name": c.name,
        "test_suite": c.test_suite,
        "framework": c.framework,
        "status": c.status,
        "duration_ms": c.duration_ms,
        "error_message": c.error_message,
        "stack_trace": c.stack_trace,
        "failure_type": c.failure_type,
        # WS1 D3 (retry / rerun capture).
        "retry_count": c.retry_count,
        "passed_on_retry": c.passed_on_retry,
        "initial_status": c.initial_status,
        # WS1 D4 (stack-trace fingerprint; None for passed/skipped).
        "failure_fingerprint": c.failure_fingerprint,
    }
    # WS1 D1: denormalize the run's start onto every case so time-window
    # queries filter directly on TestCase. Omit (leave null) when the caller
    # didn't resolve it, keeping the property optional on legacy rows.
    if run_started_at is not None:
        props["run_started_at"] = run_started_at
    return props


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
    run_started_at: str | None = None,
) -> tuple[int, int]:
    """Server-side streaming batch insert. Returns (successful, failed).

    Re-uses the parent run UUID as the belongsToRun cross-reference for
    every TestCase so downstream queries can fetch all cases of a run in
    a single hop. `run_started_at` (WS1 D1) is denormalized onto each case.
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
                properties=_case_properties(c, run_started_at=run_started_at),
                uuid=uid,
                references={"belongsToRun": run_uuid},
            )
            submitted += 1
    failed = len(collection.batch.failed_objects)
    return submitted - failed, failed
