"""Vectorizer selection for the TestCase collection.

The action supports three vectorization strategies, selected at create-time
by the `vectorizer` Config field:

- `text2vec-weaviate` (production default): Weaviate Embeddings. Needs the
  module loaded on the cluster and credentials wired via Weaviate Cloud.
- `text2vec-model2vec` (self-hosted): a lightweight inference container
  the cluster can reach. Used by weaviate-local-k8s and our integration
  tests. Requires `model2vec_inference_url` on the cluster's perspective
  (e.g., `http://model2vec-inference:8080` in-cluster).
- `none`: no vectorization. The TestRun collection always uses this;
  for TestCase, useful when the cluster has no embedding service and the
  user only wants filtering / aggregation.

Each non-`none` choice produces THREE named vectors — one per
high-signal text property:

- `name`            (test function name)
- `error_message`   (one-line failure summary)
- `stack_trace`     (full trace, medium semantic weight)

Named vectors mean callers can target the vector that best matches the
query shape (e.g., paste a stack trace -> target `stack_trace`). See
.project/02-weaviate-schema.md section 3.
"""

from __future__ import annotations

from typing import Any

import weaviate.classes.config as wvcc

VectorConfig = list[Any] | None

# The three properties on TestCase that participate in named vectors.
NAMED_VECTOR_PROPERTIES: tuple[str, ...] = ("name", "error_message", "stack_trace")


class UnknownVectorizerError(ValueError):
    """Raised when `cfg.vectorizer` is set to an unrecognized value."""


def build_test_case_vector_config(
    vectorizer: str,
    model2vec_inference_url: str | None = None,
) -> VectorConfig:
    """Return the list of named vector configs for TestCase, or None.

    Returning `None` means "create the collection without any
    vector_config" — Weaviate accepts that and treats the collection as
    self-provided / no-vectorization.
    """
    if vectorizer == "none":
        return None

    if vectorizer == "text2vec-weaviate":
        return [
            wvcc.Configure.Vectors.text2vec_weaviate(
                name=prop,
                source_properties=[prop],
                vectorize_collection_name=False,
            )
            for prop in NAMED_VECTOR_PROPERTIES
        ]

    if vectorizer == "text2vec-model2vec":
        if not model2vec_inference_url:
            raise UnknownVectorizerError(
                "text2vec-model2vec requires a non-empty model2vec_inference_url"
            )
        return [
            wvcc.Configure.Vectors.text2vec_model2vec(
                name=prop,
                source_properties=[prop],
                inference_url=model2vec_inference_url,
                vectorize_collection_name=False,
            )
            for prop in NAMED_VECTOR_PROPERTIES
        ]

    raise UnknownVectorizerError(
        f"unknown vectorizer {vectorizer!r} — accepted values: "
        f"'text2vec-weaviate', 'text2vec-model2vec', 'none'"
    )


# Default vector to query against when the caller doesn't specify one.
# stack_trace carries the most semantic weight for triage queries.
DEFAULT_TARGET_VECTOR = "stack_trace"
