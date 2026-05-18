"""Tests for the Config module — env-var loading and validation.

Distinct from github_meta which reads GH_* vars; this module reads the
action's INPUT_* / user-controlled vars: weaviate_url, weaviate_api_key,
junit_path, job_name, fail_on_error, vectorizer, model2vec_inference_url,
verbose.
"""

from __future__ import annotations

import pytest

from weaviate_test_reporter.config import Config, ConfigError


def _base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEAVIATE_URL", "https://my-cluster.weaviate.cloud")
    monkeypatch.setenv("WEAVIATE_API_KEY", "fake-test-api-key")
    monkeypatch.setenv("JUNIT_PATH", "reports/*.xml")
    monkeypatch.setenv("JOB_NAME", "e2e-backup")
    monkeypatch.setenv("FAIL_ON_ERROR", "false")
    # `VECTORIZER` defaults to text2vec-weaviate; do NOT set explicitly.
    monkeypatch.delenv("VECTORIZER", raising=False)
    monkeypatch.delenv("MODEL2VEC_INFERENCE_URL", raising=False)
    monkeypatch.delenv("VERBOSE", raising=False)


def test_from_env_happy_path(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    cfg = Config.from_env()
    assert cfg.weaviate_url == "https://my-cluster.weaviate.cloud"
    assert cfg.weaviate_api_key == "fake-test-api-key"
    assert cfg.junit_path == "reports/*.xml"
    assert cfg.job_name == "e2e-backup"
    assert cfg.fail_on_error is False
    # Defaults
    assert cfg.vectorizer == "text2vec-weaviate"
    assert cfg.model2vec_inference_url == ""
    assert cfg.verbose is False


def test_missing_weaviate_url_raises(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.delenv("WEAVIATE_URL")
    with pytest.raises(ConfigError) as exc:
        Config.from_env()
    assert "WEAVIATE_URL" in str(exc.value)


def test_missing_junit_path_raises(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.delenv("JUNIT_PATH")
    with pytest.raises(ConfigError) as exc:
        Config.from_env()
    assert "JUNIT_PATH" in str(exc.value)


def test_missing_job_name_raises(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.delenv("JOB_NAME")
    with pytest.raises(ConfigError) as exc:
        Config.from_env()
    assert "JOB_NAME" in str(exc.value)


def test_api_key_optional_defaults_to_empty(monkeypatch: pytest.MonkeyPatch):
    """Anonymous (no-auth) Weaviate instances are valid for self-hosted
    local dev. An empty WEAVIATE_API_KEY must not raise."""
    _base_env(monkeypatch)
    monkeypatch.delenv("WEAVIATE_API_KEY")
    cfg = Config.from_env()
    assert cfg.weaviate_api_key == ""


def test_fail_on_error_defaults_to_false(monkeypatch: pytest.MonkeyPatch):
    """fail_on_error MUST default false — the action is fail-safe so it
    never breaks the user's CI pipeline because of reporter issues."""
    _base_env(monkeypatch)
    monkeypatch.delenv("FAIL_ON_ERROR")
    cfg = Config.from_env()
    assert cfg.fail_on_error is False


@pytest.mark.parametrize("raw", ["true", "True", "TRUE", "1", "yes", "YES"])
def test_fail_on_error_truthy_strings(monkeypatch: pytest.MonkeyPatch, raw: str):
    _base_env(monkeypatch)
    monkeypatch.setenv("FAIL_ON_ERROR", raw)
    cfg = Config.from_env()
    assert cfg.fail_on_error is True, f"{raw!r} should parse as True"


@pytest.mark.parametrize("raw", ["false", "False", "0", "no", "", "garbage"])
def test_fail_on_error_falsy_strings(monkeypatch: pytest.MonkeyPatch, raw: str):
    _base_env(monkeypatch)
    monkeypatch.setenv("FAIL_ON_ERROR", raw)
    cfg = Config.from_env()
    assert cfg.fail_on_error is False, f"{raw!r} should parse as False"


def test_url_whitespace_is_stripped(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.setenv("WEAVIATE_URL", "  https://my-cluster.weaviate.cloud \n")
    cfg = Config.from_env()
    assert cfg.weaviate_url == "https://my-cluster.weaviate.cloud"


# ---------- vectorizer selection ----------


def test_vectorizer_defaults_to_text2vec_weaviate(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    assert Config.from_env().vectorizer == "text2vec-weaviate"


@pytest.mark.parametrize(
    "value",
    ["text2vec-weaviate", "text2vec-model2vec", "none"],
)
def test_vectorizer_accepts_known_values(
    monkeypatch: pytest.MonkeyPatch, value: str
):
    _base_env(monkeypatch)
    monkeypatch.setenv("VECTORIZER", value)
    if value == "text2vec-model2vec":
        monkeypatch.setenv("MODEL2VEC_INFERENCE_URL", "http://m2v:8080")
    assert Config.from_env().vectorizer == value


def test_vectorizer_rejects_unknown_values(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.setenv("VECTORIZER", "openai-davinci")
    with pytest.raises(ConfigError) as exc:
        Config.from_env()
    assert "VECTORIZER" in str(exc.value)
    assert "openai-davinci" in str(exc.value)


def test_model2vec_requires_inference_url(monkeypatch: pytest.MonkeyPatch):
    """model2vec without an inference URL is a misconfiguration — must
    raise rather than try and fail at create-collection time."""
    _base_env(monkeypatch)
    monkeypatch.setenv("VECTORIZER", "text2vec-model2vec")
    monkeypatch.delenv("MODEL2VEC_INFERENCE_URL", raising=False)
    with pytest.raises(ConfigError) as exc:
        Config.from_env()
    assert "MODEL2VEC_INFERENCE_URL" in str(exc.value)


def test_verbose_flag(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.setenv("VERBOSE", "true")
    assert Config.from_env().verbose is True
