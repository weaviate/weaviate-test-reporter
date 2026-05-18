"""Tests for github_meta.resolve_github_metadata.

The action receives all GitHub Actions context as GH_* environment variables
(passed in via the composite action.yml). This module purifies those into a
typed dict suitable for direct write into the TestRun Weaviate object.
"""

from __future__ import annotations

import pytest

from weaviate_test_reporter.github_meta import (
    GithubMetadataError,
    resolve_github_metadata,
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
