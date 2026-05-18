"""Action configuration: env-driven, validated at startup.

Reads the user-controlled inputs the composite action.yml declares
(WEAVIATE_URL, WEAVIATE_API_KEY, JUNIT_PATH, JOB_NAME, FAIL_ON_ERROR,
VECTORIZER, MODEL2VEC_INFERENCE_URL, VERBOSE). GitHub-context vars (GH_*)
live in github_meta — the split keeps the two failure modes
addressable independently:

- ConfigError -> user wired the action wrong (always exit non-zero).
- GithubMetadataError -> the action context is malformed (always exit
  non-zero, but the cause is GitHub's contract, not the user's input).
- Runtime/Weaviate errors -> respect fail_on_error.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

VALID_VECTORIZERS: frozenset[str] = frozenset({"text2vec-weaviate", "text2vec-model2vec", "none"})


class ConfigError(ValueError):
    """Raised on missing/invalid user-controlled inputs."""


_TRUTHY = {"true", "1", "yes"}


def _str_required(name: str) -> str:
    raw = os.environ.get(name, "").strip()
    if not raw:
        raise ConfigError(f"missing required input: {name}")
    return raw


def _str_optional(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _bool_optional(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in _TRUTHY


@dataclass(frozen=True)
class Config:
    weaviate_url: str
    weaviate_api_key: str
    junit_path: str
    job_name: str
    fail_on_error: bool
    vectorizer: str
    model2vec_inference_url: str
    verbose: bool

    @classmethod
    def from_env(cls) -> Config:
        vectorizer = _str_optional("VECTORIZER", "text2vec-weaviate")
        if vectorizer not in VALID_VECTORIZERS:
            raise ConfigError(
                f"invalid VECTORIZER {vectorizer!r}; "
                f"accepted values: {sorted(VALID_VECTORIZERS)}"
            )

        model2vec_url = _str_optional("MODEL2VEC_INFERENCE_URL")
        if vectorizer == "text2vec-model2vec" and not model2vec_url:
            raise ConfigError(
                "VECTORIZER=text2vec-model2vec requires MODEL2VEC_INFERENCE_URL "
                "(e.g., http://model2vec-inference:8080 reachable from Weaviate)"
            )

        return cls(
            weaviate_url=_str_required("WEAVIATE_URL"),
            weaviate_api_key=_str_optional("WEAVIATE_API_KEY"),
            junit_path=_str_required("JUNIT_PATH"),
            job_name=_str_required("JOB_NAME"),
            fail_on_error=_bool_optional("FAIL_ON_ERROR", default=False),
            vectorizer=vectorizer,
            model2vec_inference_url=model2vec_url,
            verbose=_bool_optional("VERBOSE", default=False),
        )
