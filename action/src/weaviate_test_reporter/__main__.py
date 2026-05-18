"""Action entry point.

`python -m weaviate_test_reporter` is what the composite action.yml invokes.
This module composes the building blocks (config, github_meta, parser,
schema, ingest, logging, vectorization) into the action lifecycle:

    1. Configure logging.
    2. Load Config + GH metadata. Hard exit non-zero if either is malformed
       (these are bugs in the workflow YAML, not transient runtime issues).
    3. Connect to Weaviate. Connection failure is a runtime issue -> respect
       fail_on_error.
    4. Ensure both collections exist (idempotent — existing schemas are
       left untouched).
    5. Glob for JUnit files. If none matched, log a warning and exit 0.
    6. Parse all files.
    7. Insert one TestRun, then batch-insert TestCases with belongsToRun
       cross-refs.
    8. Return 0 on success; 1 on hard failure when fail_on_error=true.
"""

from __future__ import annotations

import glob
import logging as stdlib_logging
import sys
from pathlib import Path
from urllib.parse import urlparse

import weaviate
from weaviate.classes.init import Auth

from .config import Config, ConfigError
from .github_meta import GithubMetadataError, resolve_github_metadata
from .ingest import ingest_test_cases, insert_test_run
from .logging import configure_logging, get_logger, group
from .parser import parse_junit_file
from .schema import ensure_test_case_collection, ensure_test_run_collection
from .vectorization import build_test_case_vector_config


def _is_localish(url: str) -> bool:
    """True if the URL points at the developer's machine / Docker host."""
    host = (urlparse(url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "host.docker.internal", "::1"}


def connect_to_weaviate(cfg: Config) -> weaviate.WeaviateClient:
    """Route to connect_to_local for localhost/docker URLs, otherwise to
    connect_to_weaviate_cloud. Auth is only attached when a key is provided
    so anonymous local Weaviate instances work out of the box.
    """
    auth = Auth.api_key(cfg.weaviate_api_key) if cfg.weaviate_api_key else None
    parsed = urlparse(cfg.weaviate_url)

    if _is_localish(cfg.weaviate_url):
        port = parsed.port or 8080
        host = parsed.hostname or "localhost"
        return weaviate.connect_to_local(
            host=host,
            port=port,
            auth_credentials=auth,
        )
    return weaviate.connect_to_weaviate_cloud(
        cluster_url=cfg.weaviate_url,
        auth_credentials=auth,
    )


def main() -> int:
    # 1. Config + GH metadata: hard failures.
    # (configure_logging is called AFTER we know cfg.verbose so the log
    # level matches the user's preference — but if config itself fails,
    # we still want a structured error line.)
    try:
        cfg = Config.from_env()
    except ConfigError as e:
        configure_logging()
        get_logger().error("config_error", error=str(e))
        return 1

    configure_logging(
        level=stdlib_logging.DEBUG if cfg.verbose else stdlib_logging.INFO
    )
    log = get_logger()

    try:
        meta = resolve_github_metadata()
    except GithubMetadataError as e:
        log.error("github_metadata_error", error=str(e))
        return 1

    log.info(
        "action_start",
        repository=meta["repository"],
        workflow=meta["workflow_name"],
        attempt=meta["workflow_run_attempt"],
        job=cfg.job_name,
        vectorizer=cfg.vectorizer,
    )

    # 2. Connect: respects fail_on_error.
    client: weaviate.WeaviateClient | None = None
    try:
        with group("Connect to Weaviate"):
            client = connect_to_weaviate(cfg)
            ensure_test_run_collection(client)
            ensure_test_case_collection(
                client,
                vector_config=build_test_case_vector_config(
                    cfg.vectorizer, cfg.model2vec_inference_url
                ),
            )
    except Exception as e:
        log.error("weaviate_connect_failed", error=str(e), error_type=type(e).__name__)
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        return 1 if cfg.fail_on_error else 0

    try:
        # 3. Glob + parse.
        with group("Parse JUnit XML"):
            files = sorted(glob.glob(cfg.junit_path, recursive=True))
            log.info("xml_files_found", count=len(files), pattern=cfg.junit_path)
            if not files:
                log.warning("no_xml_files_found", pattern=cfg.junit_path)
                return 0
            cases: list = []
            for f in files:
                file_cases = list(parse_junit_file(Path(f)))
                cases.extend(file_cases)
                log.info("parsed_file", path=f, cases=len(file_cases))
            log.info("cases_parsed_total", count=len(cases))

        # 4. Insert TestRun and batch TestCase.
        with group("Ingest into Weaviate"):
            run_uuid = insert_test_run(client, cases, meta, cfg)
            log.info("test_run_inserted", uuid=run_uuid)

            successful, failed = ingest_test_cases(
                client, cases, run_uuid,
                repository=meta["repository"],
                workflow_run_id=meta["workflow_run_id"],
                workflow_run_attempt=meta["workflow_run_attempt"],
            )
            log.info("test_cases_ingested", successful=successful, failed=failed)

        if failed > 0:
            log.error("partial_ingest_failure", failed=failed, total=len(cases))
            return 1 if cfg.fail_on_error else 0
        return 0

    except Exception as e:
        log.error("action_failed", error=str(e), error_type=type(e).__name__)
        return 1 if cfg.fail_on_error else 0
    finally:
        try:
            client.close()
        except Exception as e:
            log.warning("client_close_failed", error=str(e))


if __name__ == "__main__":
    sys.exit(main())
