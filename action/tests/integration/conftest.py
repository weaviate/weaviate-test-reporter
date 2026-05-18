"""Integration test fixtures.

Spins up a real Weaviate plus a real model2vec inference container on a
shared Docker network. One container set per pytest session (cold-start
is too slow for per-test). Each test gets fresh collections by tearing
them down between tests, so test order does not matter.

Vectorizer choice: text2vec-model2vec. This gives us realistic semantic
search behavior end-to-end (the model2vec-inference image runs a small
Snowflake/potion-retrieval model locally — ~30MB, no GPU, no cloud
credentials needed). Production uses text2vec-weaviate (WCD Embeddings);
both are real vectorizers, only the deployment differs.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator

import httpx
import pytest
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network
from testcontainers.weaviate import WeaviateContainer

from weaviate_test_reporter.schema import (
    TEST_CASE,
    TEST_RUN,
    ensure_test_case_collection,
    ensure_test_run_collection,
)
from weaviate_test_reporter.vectorization import build_test_case_vector_config

# Pin Weaviate to a recent version so server-side batching
# (collection.batch.stream) works — requires Weaviate >= 1.36.0.
WEAVIATE_IMAGE = os.environ.get("WEAVIATE_TEST_IMAGE", "semitechnologies/weaviate:1.37.3")

# Lightweight local vectorizer — the same image referenced in
# ~/repos/weaviate/docker-compose.yml. Snowflake/potion-retrieval-32M
# is small enough to run on a developer laptop without GPU.
MODEL2VEC_IMAGE = os.environ.get(
    "MODEL2VEC_TEST_IMAGE",
    "semitechnologies/model2vec-inference:minishlab-potion-retrieval-32M",
)

# Hostname used inside the shared Docker network so Weaviate can reach
# the model2vec container (it isn't reachable from the host by name).
MODEL2VEC_ALIAS = "model2vec"


class _TolerantWeaviateContainer(WeaviateContainer):
    """testcontainers' default WeaviateContainer raises on the first 503
    from /v1/.well-known/ready, but Weaviate >= 1.37 returns 503 for the
    first ~5s of startup. Poll tolerantly instead of fail-fast.
    """

    def _connect(self) -> None:  # type: ignore[override]
        deadline = time.time() + 60
        url = (
            f"http://{self.get_container_host_ip()}:"
            f"{self.get_exposed_port(8080)}/v1/.well-known/ready"
        )
        last_error: Exception | None = None
        while time.time() < deadline:
            try:
                r = httpx.get(url, timeout=5.0)
                if r.status_code == 200:
                    return
            except httpx.HTTPError as e:
                last_error = e
            time.sleep(1)
        raise TimeoutError(
            f"Weaviate readiness probe never returned 200 within 60s "
            f"(last error: {last_error!r})"
        )


def _wait_for_model2vec(container: DockerContainer) -> None:
    """The model2vec-inference image's HTTP server returns 204 No Content
    on /.well-known/ready once the model weights are loaded. Any 2xx is
    treated as success here so the probe survives upstream changes.
    """
    deadline = time.time() + 90
    host = container.get_container_host_ip()
    port = container.get_exposed_port(8080)
    url = f"http://{host}:{port}/.well-known/ready"
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            r = httpx.get(url, timeout=5.0)
            if 200 <= r.status_code < 300:
                return
        except httpx.HTTPError as e:
            last_error = e
        time.sleep(2)
    raise TimeoutError(
        f"model2vec inference probe never returned 2xx within 90s " f"(last error: {last_error!r})"
    )


@pytest.fixture(scope="session")
def docker_network() -> Iterator[Network]:
    if os.environ.get("SKIP_INTEGRATION") == "true":
        pytest.skip("SKIP_INTEGRATION=true")
    with Network() as network:
        yield network


@pytest.fixture(scope="session")
def model2vec_container(docker_network: Network) -> Iterator[DockerContainer]:
    container = (
        DockerContainer(MODEL2VEC_IMAGE)
        .with_exposed_ports(8080)
        .with_network(docker_network)
        .with_network_aliases(MODEL2VEC_ALIAS)
    )
    container.start()
    try:
        _wait_for_model2vec(container)
        yield container
    finally:
        container.stop()


@pytest.fixture(scope="session")
def weaviate_container(
    docker_network: Network, model2vec_container: DockerContainer
) -> Iterator[_TolerantWeaviateContainer]:
    """Weaviate container with text2vec-model2vec enabled and pointed at
    the sibling model2vec container via the shared network alias."""
    inference_api = f"http://{MODEL2VEC_ALIAS}:8080"
    container = _TolerantWeaviateContainer(image=WEAVIATE_IMAGE).with_network(docker_network)
    # WeaviateContainer's parent DockerContainer accepts with_env(); these
    # are the same env vars docker-compose sets to enable the module.
    container.with_env("ENABLE_MODULES", "text2vec-model2vec")
    container.with_env("MODEL2VEC_INFERENCE_API", inference_api)
    container.with_env("DEFAULT_VECTORIZER_MODULE", "none")
    container.with_env("AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED", "true")
    container.with_env("CLUSTER_HOSTNAME", "node1")
    with container as started:
        yield started


@pytest.fixture
def weaviate_client(weaviate_container, model2vec_container):
    """Fresh client + clean collections per test. TestCase is created with
    a real text2vec-model2vec vectorizer pointed at the sibling container,
    so semantic-search assertions exercise the full vectorization path."""
    inference_url = (
        f"http://{model2vec_container.get_container_host_ip()}:"
        f"{model2vec_container.get_exposed_port(8080)}"
    )
    with weaviate_container.get_client() as client:
        for cls in (TEST_CASE, TEST_RUN):
            if client.collections.exists(cls):
                client.collections.delete(cls)

        ensure_test_run_collection(client)
        # Build via the same helper the action uses so we exercise the
        # named-vector contract end-to-end.
        ensure_test_case_collection(
            client,
            vector_config=build_test_case_vector_config(
                vectorizer="text2vec-model2vec",
                # In-network alias — Weaviate reaches model2vec via DNS
                # inside the shared testcontainers network, not via the
                # host port.
                model2vec_inference_url=f"http://{MODEL2VEC_ALIAS}:8080",
            ),
        )
        # Suppress: inference_url is captured here for future use if a
        # test wants to send a vectorize request directly.
        _ = inference_url
        yield client
        for cls in (TEST_CASE, TEST_RUN):
            try:
                client.collections.delete(cls)
            except Exception:
                pass
