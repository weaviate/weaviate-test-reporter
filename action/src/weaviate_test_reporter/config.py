"""Action configuration: env-driven, validated at startup.

Reads the user-controlled inputs the composite action.yml declares
(WEAVIATE_URL, WEAVIATE_API_KEY, JUNIT_PATH, JOB_NAME, FAIL_ON_ERROR,
VECTORIZER, MODEL2VEC_INFERENCE_URL, VERBOSE, VERSION_UNDER_TEST).
GitHub-context vars (GH_*) live in github_meta — the split keeps the
two failure modes addressable independently:

- ConfigError -> user wired the action wrong (always exit non-zero).
- GithubMetadataError -> the action context is malformed (always exit
  non-zero, but the cause is GitHub's contract, not the user's input).
- Runtime/Weaviate errors -> respect fail_on_error.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import semver

VALID_VECTORIZERS: frozenset[str] = frozenset({"text2vec-weaviate", "text2vec-model2vec", "none"})


def parse_version(raw: str) -> tuple[str | None, str | None, str | None]:
    """Parse `version_under_test` into `(full, patch, minor)` slots.

    `full`  — canonical SemVer 2.0 string including any pre-release /
              build metadata. The build-unique identifier ("did we
              already test this exact build?").
    `patch` — canonical release form, `MAJOR.MINOR.PATCH`, with the
              pre-release suffix dropped. The dashboard's per-release
              rollup key.
    `minor` — `MAJOR.MINOR`. The primary grouping key on the Versions
              page.

    Uses `python-semver` (SemVer 2.0) so pre-release tags, build
    metadata, and leading-zero rejection all behave per spec.
    Tolerates an optional `v`/`V` prefix and surrounding whitespace.

    Returns `(None, None, None)` for empty input OR anything not valid
    SemVer 2.0 — the caller decides whether that's a warning or a
    hard error.

    Examples:
        "1.38.1-rfea1de"   -> ("1.38.1-rfea1de", "1.38.1", "1.38")
        "1.37.5"           -> ("1.37.5",         "1.37.5", "1.37")
        "v1.37.5"          -> ("1.37.5",         "1.37.5", "1.37")
        " 1.37.5\\n"        -> ("1.37.5",         "1.37.5", "1.37")
        "1.37.5-rc1"       -> ("1.37.5-rc1",     "1.37.5", "1.37")
        "1.37.5+build.42"  -> ("1.37.5+build.42", "1.37.5", "1.37")
        "1.37"             -> (None, None, None)   # missing patch
        "01.37.5"          -> (None, None, None)   # leading zero (spec)
        "latest_release"   -> (None, None, None)
        ""                 -> (None, None, None)
    """
    if not raw:
        return None, None, None
    cleaned = raw.strip().lstrip("vV")
    try:
        v = semver.Version.parse(cleaned)
    except (ValueError, TypeError):
        return None, None, None
    return (
        str(v),
        f"{v.major}.{v.minor}.{v.patch}",
        f"{v.major}.{v.minor}",
    )


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
    # Raw string from the action input. Parsed via `parse_version` at
    # ingest time so the malformed-warning is emitted with a properly
    # configured structlog logger. Empty when not set.
    version_under_test: str

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

        # Strict parse at startup. Empty is OK (non-version-aware
        # callers still work); non-empty MUST be valid SemVer 2.0 —
        # `parse_version` returning all-None signals failure. We raise
        # rather than warn-and-skip because the original tolerant
        # behaviour silently swallowed misconfigured CI runs (e.g. a
        # branch name accidentally fed in place of a version) and
        # produced version-less TestRuns that the dashboard couldn't
        # group. Hard-fail surfaces the mistake immediately.
        version_under_test = _str_optional("VERSION_UNDER_TEST")
        if version_under_test:
            full, _patch, _minor = parse_version(version_under_test)
            if full is None:
                raise ConfigError(
                    f"VERSION_UNDER_TEST={version_under_test!r} is not valid "
                    "SemVer 2.0. Expected a `MAJOR.MINOR.PATCH` string with "
                    "optional pre-release / build metadata, e.g. `1.38.1` or "
                    "`1.38.1-rfea1de`. Got something the SemVer 2.0 grammar "
                    "rejects (an arbitrary branch / image tag is NOT valid)."
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
            version_under_test=version_under_test,
        )
