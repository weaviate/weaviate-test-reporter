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

import json
import os
import urllib.request
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
    job_url: str


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


def _fetch_current_job_url(
    repository: str, run_id: str, run_attempt: int, token: str, runner_name: str
) -> str | None:
    """Query the GitHub jobs API for the CURRENT job (matched by runner name)
    and return its html_url, or None when no job matches. Raises on transport /
    HTTP / JSON errors — the caller (`resolve_job_url`) wraps this fail-safe."""
    api = os.environ.get("GH_API_URL", "https://api.github.com").rstrip("/")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "weaviate-test-reporter",
    }
    per_page = 100
    fallback: str | None = None  # last runner-name match if none is in_progress
    for page in range(1, 11):  # cap at 1000 jobs
        url = (
            f"{api}/repos/{repository}/actions/runs/{run_id}/attempts/"
            f"{run_attempt}/jobs?per_page={per_page}&page={page}"
        )
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
        jobs = payload.get("jobs") or []
        for job in jobs:
            if job.get("runner_name") == runner_name and job.get("html_url"):
                # The reporter step runs INSIDE its job, so that job is
                # `in_progress` — return the moment we see it and stop paging.
                if job.get("status") == "in_progress":
                    return job["html_url"]
                # Keep a completed/queued match only as a fallback (rare API
                # timing where the current job isn't `in_progress` yet).
                fallback = job["html_url"]
        if len(jobs) < per_page:
            break
    return fallback


def resolve_job_url(*, repository: str, run_id: str, run_attempt: int, run_url: str) -> str:
    """Best-effort per-job deep-link (WS1 D5).

    The current job's html_url isn't exposed in the Actions env, so resolve it
    from the jobs API, matching the job that ran on THIS runner (RUNNER_NAME).
    FULLY FAIL-SAFE: returns `run_url` (the run+attempt page) when the token or
    runner name is absent, the API errors, or no job matches — a best-effort
    link must never break the reporter.
    """
    token = os.environ.get("GH_TOKEN", "").strip()
    runner_name = os.environ.get("GH_RUNNER_NAME", "").strip()
    if not token or not runner_name:
        return run_url
    try:
        job_url = _fetch_current_job_url(repository, run_id, run_attempt, token, runner_name)
    except Exception:
        return run_url
    return job_url or run_url


def resolve_github_metadata() -> GithubMetadata:
    """Read GH_* env vars and return a metadata dict for TestRun ingestion."""
    for var in REQUIRED:
        if os.environ.get(var) is None or os.environ.get(var) == "":
            raise GithubMetadataError(f"missing required env var: {var}")

    repository = _require("GH_REPOSITORY")
    run_id = _require("GH_RUN_ID")
    run_attempt = _int_required("GH_RUN_ATTEMPT")
    server_url = _require("GH_SERVER_URL").rstrip("/")

    run_url = f"{server_url}/{repository}/actions/runs/{run_id}/attempts/{run_attempt}"
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
        "run_url": run_url,
        # WS1 D5: best-effort per-job deep-link; falls back to run_url.
        "job_url": resolve_job_url(
            repository=repository,
            run_id=run_id,
            run_attempt=run_attempt,
            run_url=run_url,
        ),
    }
    return meta  # type: ignore[return-value]
