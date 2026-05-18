"""Resolve GitHub Actions context (GH_* env vars) into a typed metadata dict.

The composite action.yml passes every relevant `${{ github.* }}` value as a
GH_-prefixed env var into the Python entry point. This module is the single
boundary between GitHub's untyped env contract and the strongly-typed
TestRun properties stored in Weaviate.

Why GH_-prefix instead of GITHUB_-prefix? GitHub Actions reserves GITHUB_*
and re-emits its own values, so wrapping in GH_* keeps the contract under
this action's control and lets us pick which context fields we want.
"""

from __future__ import annotations

import os
from typing import Any, TypedDict

REQUIRED = (
    "GH_REPOSITORY",
    "GH_RUN_ID",
    "GH_RUN_ATTEMPT",
    "GH_WORKFLOW",
    "GH_REF",
    "GH_SHA",
    "GH_EVENT_NAME",
    "GH_ACTOR",
    "GH_SERVER_URL",
)


class GithubMetadataError(ValueError):
    """Raised when GH_* env vars are missing or malformed.

    Distinct from a generic ValueError so the entry point can decide that
    these errors are user-config bugs (always exit non-zero), independent
    of the fail_on_error knob which controls runtime/Weaviate failures.
    """


class GithubMetadata(TypedDict):
    repository: str
    workflow_run_id: str
    workflow_run_attempt: int
    workflow_name: str
    branch: str
    commit_hash: str
    trigger_type: str
    actor: str
    pr_number: int | None
    run_url: str


def _require(name: str) -> str:
    val = os.environ.get(name)
    if val is None or val == "":
        raise GithubMetadataError(f"missing required env var: {name}")
    return val


def _int_required(name: str) -> int:
    raw = _require(name)
    try:
        return int(raw)
    except ValueError as e:
        raise GithubMetadataError(f"{name} must be an integer, got {raw!r}") from e


def _int_optional(name: str) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        # GitHub sometimes emits "null" or "" for missing PR numbers on
        # non-PR events. Be forgiving here — the action's job is to ingest
        # whatever CI throws at it, not to enforce GitHub's contract.
        return None


def _normalize_trigger(event_name: str) -> str:
    """Map GitHub event_name to dashboard-friendly trigger_type.

    Per `.project/02-weaviate-schema.md`, trigger_type values are documented
    as `pull_request`, `push`, `cron`. GitHub itself emits `schedule` for
    cron-triggered runs, so we translate.
    """
    if event_name == "schedule":
        return "cron"
    return event_name


def resolve_github_metadata() -> GithubMetadata:
    """Read GH_* env vars and return a metadata dict for TestRun ingestion."""
    for var in REQUIRED:
        if os.environ.get(var) is None or os.environ.get(var) == "":
            raise GithubMetadataError(f"missing required env var: {var}")

    repository = _require("GH_REPOSITORY")
    run_id = _require("GH_RUN_ID")
    run_attempt = _int_required("GH_RUN_ATTEMPT")
    server_url = _require("GH_SERVER_URL").rstrip("/")

    meta: dict[str, Any] = {
        "repository": repository,
        "workflow_run_id": run_id,
        "workflow_run_attempt": run_attempt,
        "workflow_name": _require("GH_WORKFLOW"),
        "branch": _require("GH_REF"),
        "commit_hash": _require("GH_SHA"),
        "trigger_type": _normalize_trigger(_require("GH_EVENT_NAME")),
        "actor": _require("GH_ACTOR"),
        "pr_number": _int_optional("GH_PR_NUMBER"),
        "run_url": (
            f"{server_url}/{repository}/actions/runs/{run_id}/attempts/{run_attempt}"
        ),
    }
    return meta  # type: ignore[return-value]
