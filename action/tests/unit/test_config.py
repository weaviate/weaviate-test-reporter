"""Tests for the Config module — env-var loading and validation.

Distinct from github_meta which reads GH_* vars; this module reads the
action's INPUT_* / user-controlled vars: weaviate_url, weaviate_api_key,
junit_path, job_name, fail_on_error, vectorizer, model2vec_inference_url,
verbose.
"""

from __future__ import annotations

import pytest

from weaviate_test_reporter.config import Config, ConfigError, parse_version


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
def test_vectorizer_accepts_known_values(monkeypatch: pytest.MonkeyPatch, value: str):
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


# ---------- version_under_test + parse_version ----------


def test_version_under_test_defaults_to_empty(monkeypatch: pytest.MonkeyPatch):
    _base_env(monkeypatch)
    monkeypatch.delenv("VERSION_UNDER_TEST", raising=False)
    assert Config.from_env().version_under_test == ""


def test_version_under_test_is_stored_raw(monkeypatch: pytest.MonkeyPatch):
    """Validation deferred to ingest-time so the structlog warning lands
    with a properly configured logger. Config just stores the raw value."""
    _base_env(monkeypatch)
    monkeypatch.setenv("VERSION_UNDER_TEST", "1.37.5")
    assert Config.from_env().version_under_test == "1.37.5"


def test_version_under_test_keeps_malformed_raw(monkeypatch: pytest.MonkeyPatch):
    """Even malformed values are stored as-is; from_env never raises on
    version handling (warn-and-skip semantics)."""
    _base_env(monkeypatch)
    monkeypatch.setenv("VERSION_UNDER_TEST", "latest_release")
    cfg = Config.from_env()
    assert cfg.version_under_test == "latest_release"
    # The downstream parser is the one that surfaces (None, None) and
    # the warning — covered in test_parse_version_* below.


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("1.37.5", ("1.37.5", "1.37")),
        ("v1.37.5", ("1.37.5", "1.37")),
        ("V1.37.5", ("1.37.5", "1.37")),
        (" 1.37.5\n", ("1.37.5", "1.37")),
        ("1.37.5-rc1", ("1.37.5-rc1", "1.37")),
        ("1.37.5+build.42", ("1.37.5+build.42", "1.37")),
        ("1.37.5-rc1+build.42", ("1.37.5-rc1+build.42", "1.37")),
        ("0.0.1", ("0.0.1", "0.0")),
        ("10.20.30", ("10.20.30", "10.20")),
    ],
)
def test_parse_version_accepts_valid_semver(raw: str, expected: tuple[str, str]):
    assert parse_version(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "1.37",  # missing patch — not valid SemVer 2.0
        "1",  # major only
        "01.37.5",  # leading zero forbidden by spec
        "latest_release",  # the literal GH-Actions placeholder
        "v",  # only the optional prefix
        "abc",
        "1.37.5.6",  # 4 segments
        "1.37.5-",  # trailing hyphen / empty prerelease
    ],
)
def test_parse_version_returns_none_pair_on_invalid_input(raw: str):
    assert parse_version(raw) == (None, None)
