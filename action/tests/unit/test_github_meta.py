"""Tests for github_meta.resolve_github_metadata.

The action receives all GitHub Actions context as GH_* environment variables
(passed in via the composite action.yml). This module purifies those into a
typed dict suitable for direct write into the TestRun Weaviate object.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from weaviate_test_reporter.github_meta import (
    GithubMetadataError,
    resolve_github_metadata,
    resolve_job_url,
)


def _base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Populate the minimum set of GH_* vars the action expects."""
    monkeypatch.setenv("GH_REPOSITORY", "weaviate/weaviate")
    monkeypatch.setenv("GH_RUN_ID", "12345")
    monkeypatch.setenv("GH_RUN_ATTEMPT", "2")
    monkeypatch.setenv("GH_WORKFLOW", "ci")
    monkeypatch.setenv("GH_REF", "main")
    monkeypatch.setenv("GH_SHA", "abc123def456")
    monkeypatch.setenv("GH_EVENT_NAME", "push")
    monkeypatch.setenv("GH_ACTOR", "alice")
    monkeypatch.setenv("GH_SERVER_URL", "https://github.com")
    monkeypatch.setenv("GH_PR_NUMBER", "")


def test_resolve_push_event(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    meta = resolve_github_metadata()

    assert meta["repository"] == "weaviate/weaviate"
    assert meta["workflow_run_id"] == "12345"
    assert meta["workflow_run_attempt"] == 2
    assert meta["workflow_name"] == "ci"
    assert meta["branch"] == "main"
    assert meta["commit_hash"] == "abc123def456"
    assert meta["trigger_type"] == "push"
    assert meta["actor"] == "alice"
    assert meta["pr_number"] is None
    assert meta["run_url"] == ("https://github.com/weaviate/weaviate/actions/runs/12345/attempts/2")


def test_resolve_pull_request_event(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.setenv("GH_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GH_PR_NUMBER", "789")

    meta = resolve_github_metadata()

    assert meta["trigger_type"] == "pull_request"
    assert meta["pr_number"] == 789


def test_resolve_scheduled_event_maps_to_cron(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.setenv("GH_EVENT_NAME", "schedule")

    meta = resolve_github_metadata()
    # We normalize GitHub's "schedule" event_name to our "cron" trigger_type
    # because that's the term the dashboard uses.
    assert meta["trigger_type"] == "cron"


def test_resolve_workflow_dispatch_event_passes_through(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.setenv("GH_EVENT_NAME", "workflow_dispatch")

    meta = resolve_github_metadata()
    assert meta["trigger_type"] == "workflow_dispatch"


def test_missing_required_env_var_raises(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.delenv("GH_REPOSITORY", raising=False)

    with pytest.raises(GithubMetadataError) as exc:
        resolve_github_metadata()
    assert "GH_REPOSITORY" in str(exc.value)


def test_non_integer_run_attempt_raises(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.setenv("GH_RUN_ATTEMPT", "not-a-number")

    with pytest.raises(GithubMetadataError) as exc:
        resolve_github_metadata()
    assert "GH_RUN_ATTEMPT" in str(exc.value)


def test_invalid_pr_number_treated_as_none(monkeypatch: pytest.MonkeyPatch):
    """GitHub provides an empty string for pr_number on non-PR events.
    Any non-integer value (rather than raising) is normalized to None so
    the action never fails on a quirk of GitHub's env-var contract.
    """
    _base_env(monkeypatch)
    monkeypatch.setenv("GH_PR_NUMBER", "null")

    meta = resolve_github_metadata()
    assert meta["pr_number"] is None


def test_run_url_uses_server_url_for_ghes(monkeypatch: pytest.MonkeyPatch):
    """GitHub Enterprise Server has a custom server URL — the run_url must
    honor it so links land on the right server."""
    _base_env(monkeypatch)
    monkeypatch.setenv("GH_SERVER_URL", "https://github.acme-corp.internal")

    meta = resolve_github_metadata()
    assert meta["run_url"].startswith("https://github.acme-corp.internal/")


# ---------- WS1 D5: per-job deep-link resolution ----------

_RUN_URL = "https://github.com/o/r/actions/runs/1/attempts/1"


def _urlopen_returning(payload: dict):
    """A urlopen stand-in whose context manager `.read()` returns JSON bytes."""
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode()
    cm = MagicMock()
    cm.__enter__.return_value = resp
    return MagicMock(return_value=cm)


def test_resolve_job_url_returns_run_url_without_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.setenv("GH_RUNNER_NAME", "runner-1")
    got = resolve_job_url(repository="o/r", run_id="1", run_attempt=1, run_url=_RUN_URL)
    assert got == _RUN_URL


def test_resolve_job_url_matches_current_job_by_runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GH_TOKEN", "t")
    monkeypatch.setenv("GH_RUNNER_NAME", "runner-2")
    payload = {
        "jobs": [
            {"runner_name": "runner-1", "status": "completed", "html_url": "https://x/job/1"},
            {"runner_name": "runner-2", "status": "in_progress", "html_url": "https://x/job/2"},
        ]
    }
    with patch(
        "weaviate_test_reporter.github_meta.urllib.request.urlopen",
        _urlopen_returning(payload),
    ):
        got = resolve_job_url(repository="o/r", run_id="1", run_attempt=1, run_url=_RUN_URL)
    assert got == "https://x/job/2"


def test_resolve_job_url_falls_back_when_no_runner_match(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GH_TOKEN", "t")
    monkeypatch.setenv("GH_RUNNER_NAME", "runner-absent")
    payload = {
        "jobs": [
            {"runner_name": "runner-1", "status": "in_progress", "html_url": "https://x/job/1"}
        ]
    }
    with patch(
        "weaviate_test_reporter.github_meta.urllib.request.urlopen",
        _urlopen_returning(payload),
    ):
        got = resolve_job_url(repository="o/r", run_id="1", run_attempt=1, run_url=_RUN_URL)
    assert got == _RUN_URL


def test_resolve_job_url_uses_completed_match_when_none_in_progress(
    monkeypatch: pytest.MonkeyPatch,
):
    """API-timing edge: if no runner-name match is `in_progress` yet, the last
    such match is used rather than dropping to run_url."""
    monkeypatch.setenv("GH_TOKEN", "t")
    monkeypatch.setenv("GH_RUNNER_NAME", "runner-2")
    payload = {
        "jobs": [{"runner_name": "runner-2", "status": "completed", "html_url": "https://x/job/9"}]
    }
    with patch(
        "weaviate_test_reporter.github_meta.urllib.request.urlopen",
        _urlopen_returning(payload),
    ):
        got = resolve_job_url(repository="o/r", run_id="1", run_attempt=1, run_url=_RUN_URL)
    assert got == "https://x/job/9"


def test_resolve_job_url_falls_back_on_api_error(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GH_TOKEN", "t")
    monkeypatch.setenv("GH_RUNNER_NAME", "runner-2")
    with patch(
        "weaviate_test_reporter.github_meta.urllib.request.urlopen",
        MagicMock(side_effect=OSError("network down")),
    ):
        got = resolve_job_url(repository="o/r", run_id="1", run_attempt=1, run_url=_RUN_URL)
    assert got == _RUN_URL


def test_metadata_job_url_defaults_to_run_url_without_token(monkeypatch: pytest.MonkeyPatch):
    """End-to-end wiring: with no token the resolved job_url mirrors run_url."""
    _base_env(monkeypatch)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    meta = resolve_github_metadata()
    assert meta["job_url"] == meta["run_url"]
