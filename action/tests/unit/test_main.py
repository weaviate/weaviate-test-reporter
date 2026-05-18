"""Tests for the main entry point.

main() composes Config, github_meta, the parser, schema, and ingest.
These tests pin the integration points without spinning up Weaviate:

- Config or GH-metadata errors -> exit 1 (config bugs are never silent).
- No XML files matched -> log warning, exit 0 (the user's CI may have
  emitted no reports — that should not break their pipeline).
- Weaviate connection failure -> exit per fail_on_error.
- Ingestion failure (some objects rejected by server) -> exit per
  fail_on_error.
- Happy path -> exit 0; insert_test_run + ingest_test_cases both called.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


FIXTURE = Path(__file__).parent / "fixtures" / "pytest_simple.xml"


def _full_env(monkeypatch: pytest.MonkeyPatch, junit_path: str) -> None:
    monkeypatch.setenv("WEAVIATE_URL", "http://localhost:8080")
    monkeypatch.setenv("WEAVIATE_API_KEY", "")
    monkeypatch.setenv("JUNIT_PATH", junit_path)
    monkeypatch.setenv("JOB_NAME", "test-job")
    monkeypatch.setenv("FAIL_ON_ERROR", "false")
    monkeypatch.setenv("GH_REPOSITORY", "weaviate/weaviate")
    monkeypatch.setenv("GH_RUN_ID", "1")
    monkeypatch.setenv("GH_RUN_ATTEMPT", "1")
    monkeypatch.setenv("GH_WORKFLOW", "ci")
    monkeypatch.setenv("GH_REF", "main")
    monkeypatch.setenv("GH_SHA", "deadbeef")
    monkeypatch.setenv("GH_EVENT_NAME", "push")
    monkeypatch.setenv("GH_ACTOR", "bot")
    monkeypatch.setenv("GH_SERVER_URL", "https://github.com")
    monkeypatch.setenv("GH_PR_NUMBER", "")
    # Clear optional env that Config.from_env consults so the defaults
    # apply consistently across tests.
    monkeypatch.delenv("VECTORIZER", raising=False)
    monkeypatch.delenv("MODEL2VEC_INFERENCE_URL", raising=False)
    monkeypatch.delenv("VERBOSE", raising=False)


def test_main_returns_zero_on_happy_path(monkeypatch: pytest.MonkeyPatch):
    _full_env(monkeypatch, str(FIXTURE))
    from weaviate_test_reporter.__main__ import main

    fake_client = MagicMock()
    fake_collection = MagicMock()
    fake_client.collections.get.return_value = fake_collection
    fake_collection.batch.failed_objects = []

    with patch("weaviate_test_reporter.__main__.connect_to_weaviate", return_value=fake_client):
        rc = main()

    assert rc == 0
    # ensure_test_run_collection + ensure_test_case_collection both called
    # (idempotent — but they always check exists first)
    assert fake_client.collections.exists.call_count == 2
    # TestRun insert called once; TestCase batch.stream() called once
    fake_client.collections.get.assert_any_call("TestRun")
    fake_client.collections.get.assert_any_call("TestCase")


def test_main_returns_one_on_config_error(monkeypatch: pytest.MonkeyPatch):
    """Missing required input is always a non-zero exit, regardless of
    fail_on_error — the user wired the action wrong."""
    _full_env(monkeypatch, str(FIXTURE))
    monkeypatch.delenv("WEAVIATE_URL")
    monkeypatch.setenv("FAIL_ON_ERROR", "false")  # explicit: doesn't help

    from weaviate_test_reporter.__main__ import main
    assert main() == 1


def test_main_returns_one_on_github_metadata_error(monkeypatch: pytest.MonkeyPatch):
    _full_env(monkeypatch, str(FIXTURE))
    monkeypatch.delenv("GH_REPOSITORY")
    monkeypatch.setenv("FAIL_ON_ERROR", "false")

    from weaviate_test_reporter.__main__ import main
    assert main() == 1


def test_main_warns_and_exits_zero_on_no_xml_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """An empty glob is a soft warning — most teams just want the action
    to be a no-op when their job didn't produce a report."""
    _full_env(monkeypatch, str(tmp_path / "nonexistent*.xml"))
    from weaviate_test_reporter.__main__ import main

    fake_client = MagicMock()
    with patch("weaviate_test_reporter.__main__.connect_to_weaviate", return_value=fake_client):
        rc = main()
    assert rc == 0
    # Should not have attempted to insert anything
    fake_client.collections.get.assert_not_called()


def test_main_returns_zero_on_weaviate_connect_failure_when_failsafe(
    monkeypatch: pytest.MonkeyPatch,
):
    """fail_on_error=false (default): reporter never breaks the user's CI."""
    _full_env(monkeypatch, str(FIXTURE))
    monkeypatch.setenv("FAIL_ON_ERROR", "false")
    from weaviate_test_reporter.__main__ import main

    with patch(
        "weaviate_test_reporter.__main__.connect_to_weaviate",
        side_effect=ConnectionError("cluster unreachable"),
    ):
        rc = main()
    assert rc == 0


def test_main_returns_one_on_weaviate_connect_failure_when_strict(
    monkeypatch: pytest.MonkeyPatch,
):
    _full_env(monkeypatch, str(FIXTURE))
    monkeypatch.setenv("FAIL_ON_ERROR", "true")
    from weaviate_test_reporter.__main__ import main

    with patch(
        "weaviate_test_reporter.__main__.connect_to_weaviate",
        side_effect=ConnectionError("cluster unreachable"),
    ):
        rc = main()
    assert rc == 1


def test_main_returns_one_when_partial_ingest_failure_and_strict(
    monkeypatch: pytest.MonkeyPatch,
):
    """If the Weaviate server rejects some objects, fail_on_error=true
    surfaces that as a non-zero exit."""
    _full_env(monkeypatch, str(FIXTURE))
    monkeypatch.setenv("FAIL_ON_ERROR", "true")
    from weaviate_test_reporter.__main__ import main

    fake_client = MagicMock()
    fake_collection = MagicMock()
    fake_client.collections.get.return_value = fake_collection
    # One object failed server-side validation
    fake_collection.batch.failed_objects = [MagicMock()]

    with patch("weaviate_test_reporter.__main__.connect_to_weaviate", return_value=fake_client):
        rc = main()
    assert rc == 1


def test_main_returns_zero_when_partial_ingest_failure_and_failsafe(
    monkeypatch: pytest.MonkeyPatch,
):
    _full_env(monkeypatch, str(FIXTURE))
    monkeypatch.setenv("FAIL_ON_ERROR", "false")
    from weaviate_test_reporter.__main__ import main

    fake_client = MagicMock()
    fake_collection = MagicMock()
    fake_client.collections.get.return_value = fake_collection
    fake_collection.batch.failed_objects = [MagicMock()]  # 1 failed

    with patch("weaviate_test_reporter.__main__.connect_to_weaviate", return_value=fake_client):
        rc = main()
    assert rc == 0


# ---------- connect_to_weaviate routing ----------


def _make_cfg(**overrides):
    from weaviate_test_reporter.config import Config
    defaults = dict(
        weaviate_url="http://localhost:8080",
        weaviate_api_key="",
        junit_path="*.xml",
        job_name="j",
        fail_on_error=False,
        vectorizer="text2vec-weaviate",
        model2vec_inference_url="",
        verbose=False,
    )
    defaults.update(overrides)
    return Config(**defaults)


def test_connect_to_weaviate_routes_localhost():
    from weaviate_test_reporter.__main__ import connect_to_weaviate
    cfg = _make_cfg(weaviate_url="http://localhost:8080")
    with patch("weaviate.connect_to_local") as ctl:
        connect_to_weaviate(cfg)
        ctl.assert_called_once()
        kwargs = ctl.call_args.kwargs
        assert kwargs["host"] == "localhost"
        assert kwargs["port"] == 8080


def test_connect_to_weaviate_handles_trailing_path():
    """urllib.parse.urlparse must extract host/port cleanly even if the
    URL ends with a path component."""
    from weaviate_test_reporter.__main__ import connect_to_weaviate
    cfg = _make_cfg(weaviate_url="http://localhost:8080/foo/bar")
    with patch("weaviate.connect_to_local") as ctl:
        connect_to_weaviate(cfg)
        kwargs = ctl.call_args.kwargs
        assert kwargs["host"] == "localhost"
        assert kwargs["port"] == 8080


def test_connect_to_weaviate_routes_cloud_url():
    from weaviate_test_reporter.__main__ import connect_to_weaviate
    cfg = _make_cfg(
        weaviate_url="https://my-cluster.weaviate.cloud",
        weaviate_api_key="my-key",
    )
    with patch("weaviate.connect_to_weaviate_cloud") as cwc:
        connect_to_weaviate(cfg)
        cwc.assert_called_once()
        kwargs = cwc.call_args.kwargs
        assert kwargs["cluster_url"] == "https://my-cluster.weaviate.cloud"
        # Auth must be passed when api_key is non-empty
        assert kwargs["auth_credentials"] is not None
