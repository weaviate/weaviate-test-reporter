"""Tests for the logging module.

structlog setup + GitHub Actions log groups. The renderer flips between
JSON (in GitHub Actions) and human-readable (locally) based on the
GITHUB_ACTIONS env var, which Actions sets to "true" automatically.

The group() context manager emits `::group::name` / `::endgroup::` only
when running in GH Actions — those are control sequences the Actions UI
parses to make collapsible sections in the CI log.
"""

from __future__ import annotations

import io
import json
import logging
from contextlib import redirect_stdout

import pytest

from weaviate_test_reporter.logging import configure_logging, get_logger, group


@pytest.fixture(autouse=True)
def _reset_logging():
    """structlog/stdlib logging are process-global; reset between tests so
    a JSON config from one test does not leak into the next.
    """
    # Save handlers
    root = logging.getLogger()
    original_handlers = root.handlers[:]
    original_level = root.level
    yield
    # Restore
    root.handlers = original_handlers
    root.setLevel(original_level)


def test_configure_logging_in_github_actions_emits_json(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    configure_logging()
    log = get_logger()

    buf = io.StringIO()
    with redirect_stdout(buf):
        log.info("event_name", count=3, repository="weaviate/weaviate")

    line = buf.getvalue().strip()
    payload = json.loads(line)  # MUST parse as JSON
    assert payload["event"] == "event_name"
    assert payload["count"] == 3
    assert payload["repository"] == "weaviate/weaviate"
    assert payload["level"] == "info"


def test_configure_logging_locally_emits_human_readable(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    configure_logging()
    log = get_logger()

    buf = io.StringIO()
    with redirect_stdout(buf):
        log.info("event_name", count=3)

    out = buf.getvalue()
    # Console renderer is NOT JSON — it has the event name unquoted and
    # uses key=value pairs.
    assert "event_name" in out
    # Should not be valid JSON
    with pytest.raises(json.JSONDecodeError):
        json.loads(out.strip())


def test_group_emits_markers_in_github_actions(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")

    buf = io.StringIO()
    with redirect_stdout(buf):
        with group("Connect to Weaviate"):
            print("inside")

    out = buf.getvalue()
    assert "::group::Connect to Weaviate" in out
    assert "::endgroup::" in out
    # Marker order: open marker comes before inside, endgroup comes after
    assert out.index("::group::") < out.index("inside") < out.index("::endgroup::")


def test_group_is_silent_outside_github_actions(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)

    buf = io.StringIO()
    with redirect_stdout(buf):
        with group("local"):
            print("inside")

    out = buf.getvalue()
    assert "::group::" not in out
    assert "::endgroup::" not in out
    assert "inside" in out


def test_group_endgroup_emitted_even_if_body_raises(monkeypatch: pytest.MonkeyPatch):
    """If the body raises, the endgroup marker MUST still emit — otherwise
    the CI log stays collapsed and the user can't see the failure detail.
    """
    monkeypatch.setenv("GITHUB_ACTIONS", "true")

    buf = io.StringIO()
    with pytest.raises(RuntimeError), redirect_stdout(buf):
        with group("oops"):
            raise RuntimeError("boom")

    out = buf.getvalue()
    assert "::group::oops" in out
    assert "::endgroup::" in out


def test_logger_includes_timestamp_in_json(monkeypatch: pytest.MonkeyPatch):
    """Timestamps are essential for correlating CI log lines with Weaviate
    server-side events during debugging."""
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    configure_logging()
    log = get_logger()

    buf = io.StringIO()
    with redirect_stdout(buf):
        log.info("ping")

    payload = json.loads(buf.getvalue().strip())
    assert "timestamp" in payload
