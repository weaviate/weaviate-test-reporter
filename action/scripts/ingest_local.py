"""Ingest a real JUnit XML file into a local Weaviate cluster.

A developer convenience: same pipeline the production action runs, but
parameterized for local testing where there's no GitHub Actions context.
Missing context (run_id, actor, branch, PR number) is synthesized so the
TestRun row is still well-formed.

Usage
-----

    # Default: ingest the bundled fixture, synthesizing all GH metadata.
    .venv/bin/python scripts/ingest_local.py tests/unit/fixtures/pytest_simple.xml

    # Custom job name / suite identity:
    .venv/bin/python scripts/ingest_local.py reports/junit.xml \\
        --job-name e2e-rbac --branch feature/rbac --actor jose

    # Against a different Weaviate (e.g., WCD):
    WEAVIATE_URL=https://my-cluster.weaviate.cloud WEAVIATE_API_KEY=$KEY \\
        .venv/bin/python scripts/ingest_local.py reports/junit.xml

Vectorizer
----------

Defaults to text2vec-model2vec pointed at the in-cluster
`model2vec-inference` service that weaviate-local-k8s ships with. Use
`--vectorizer none` to disable vectorization (useful for ingesting into a
plain Weaviate without modules), or `--vectorizer text2vec-weaviate` to
match the production schema (needs WCD Embeddings access).

The schema is created idempotently on first run; subsequent runs ingest
into the existing collections.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# Allow running as a script without an editable install.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import weaviate
from weaviate.classes.init import Auth

from weaviate_test_reporter.ingest import (
    _run_uuid,
    aggregate_run_properties,
    ingest_test_cases,
    resolve_run_started_at,
)
from weaviate_test_reporter.parser import parse_junit_file, parse_junit_summary
from weaviate_test_reporter.schema import (
    TEST_RUN,
    ensure_test_case_collection,
    ensure_test_run_collection,
)
from weaviate_test_reporter.vectorization import (
    UnknownVectorizerError,
    build_test_case_vector_config,
)

MODEL2VEC_IN_CLUSTER = "http://model2vec-inference.weaviate.svc.cluster.local.:8080"


def _detect_git_branch() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out or "main"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "main"


def _detect_git_sha() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out or "synthetic"
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "synthetic"


def _synthesize_run_id(junit_path: Path) -> str:
    """Derive a stable-but-unique workflow_run_id from path + timestamp.

    We hash the path so the same file ingested twice doesn't collide via
    GitHub's run_id namespace, but if the user re-runs immediately on the
    same file they DO collide (and the upsert path takes over). This is
    intended: local ingestion is for iterating on a single report.
    """
    h = hashlib.sha256(str(junit_path.resolve()).encode()).hexdigest()[:8]
    return f"local-{h}"


def _build_vector_config(name: str, inference_url: str) -> Any:
    """Thin wrapper around the package helper. Reraises as SystemExit so
    bad CLI args produce a clean error rather than a stack trace."""
    try:
        return build_test_case_vector_config(
            vectorizer=name,
            model2vec_inference_url=inference_url or None,
        )
    except UnknownVectorizerError as e:
        raise SystemExit(str(e)) from e


def _connect(url: str, api_key: str) -> weaviate.WeaviateClient:
    auth = Auth.api_key(api_key) if api_key else None
    if "localhost" in url or "127.0.0.1" in url or "host.docker.internal" in url:
        bare = url.replace("https://", "").replace("http://", "").rstrip("/")
        host, _, port = bare.partition(":")
        return weaviate.connect_to_local(
            host=host or "localhost",
            port=int(port) if port else 8080,
            auth_credentials=auth,
        )
    return weaviate.connect_to_weaviate_cloud(cluster_url=url, auth_credentials=auth)


class _Config:
    """Lightweight stand-in for action.config.Config so we can reuse
    aggregate_run_properties without going through env-var validation."""

    def __init__(self, job_name: str, version_under_test: str = ""):
        self.job_name = job_name
        # aggregate_run_properties parses this into the three version slots
        # (empty -> all None). Present so the dev script exercises the same
        # code path as the production Config (required since Phase 5b).
        self.version_under_test = version_under_test


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Ingest a JUnit XML file into a local Weaviate cluster.",
    )
    parser.add_argument(
        "junit_path",
        type=Path,
        help="Path to a JUnit XML file (pytest / gotestsum / jest / surefire).",
    )
    parser.add_argument(
        "--weaviate-url",
        default=os.environ.get("WEAVIATE_URL", "http://localhost:8080"),
        help="Weaviate URL (default: http://localhost:8080).",
    )
    parser.add_argument(
        "--weaviate-api-key",
        default=os.environ.get("WEAVIATE_API_KEY", ""),
        help="Weaviate API key. Empty for anonymous local instances.",
    )
    parser.add_argument(
        "--vectorizer",
        choices=["text2vec-model2vec", "text2vec-weaviate", "none"],
        default="text2vec-model2vec",
        help="Vectorizer to configure on TestCase (only used on first ingest).",
    )
    parser.add_argument(
        "--model2vec-inference-url",
        default=MODEL2VEC_IN_CLUSTER,
        help="Inference URL for text2vec-model2vec (default: in-cluster DNS).",
    )

    # Synthetic GitHub metadata — overridable.
    parser.add_argument("--repository", default="local/dev")
    parser.add_argument("--job-name", default="local-ingest")
    parser.add_argument("--workflow-name", default="local")
    parser.add_argument(
        "--branch", default=None, help="Defaults to the current git branch, or 'main'."
    )
    parser.add_argument("--commit-hash", default=None, help="Defaults to git HEAD, or 'synthetic'.")
    parser.add_argument("--actor", default=None, help=f"Defaults to $USER ({getpass.getuser()!r}).")
    parser.add_argument(
        "--workflow-run-id", default=None, help="Defaults to a stable hash of the file path."
    )
    parser.add_argument("--workflow-run-attempt", type=int, default=1)
    parser.add_argument(
        "--trigger-type",
        default="push",
        choices=["push", "pull_request", "cron", "workflow_dispatch"],
    )
    parser.add_argument("--pr-number", type=int, default=None)
    parser.add_argument(
        "--version-under-test",
        default="",
        help="SemVer of the artifact under test (e.g. 1.38.1). Empty = no version slots.",
    )

    args = parser.parse_args(argv)

    junit_path: Path = args.junit_path
    if not junit_path.is_file():
        print(f"error: {junit_path} is not a file", file=sys.stderr)
        return 1

    # Resolve synthetic defaults.
    branch = args.branch or _detect_git_branch()
    commit_hash = args.commit_hash or _detect_git_sha()
    actor = args.actor or getpass.getuser() or "local-user"
    workflow_run_id = args.workflow_run_id or _synthesize_run_id(junit_path)

    meta: dict[str, Any] = {
        "repository": args.repository,
        "workflow_run_id": workflow_run_id,
        "workflow_run_attempt": args.workflow_run_attempt,
        "workflow_name": args.workflow_name,
        "branch": branch,
        "commit_hash": commit_hash,
        "trigger_type": args.trigger_type,
        "actor": actor,
        "pr_number": args.pr_number,
        "run_url": f"local://{junit_path.resolve()}",
    }
    cfg = _Config(job_name=args.job_name, version_under_test=args.version_under_test)

    print(f"→ Parsing {junit_path}")
    cases = list(parse_junit_file(junit_path))
    if not cases:
        print("  (no test cases found — nothing to ingest)")
        return 0
    # WS1 D1/D2: real run-start timestamp + run-level counts from the
    # <testsuite> summary, mirrored onto the TestRun and denormalized onto
    # every TestCase (matches the production __main__ path).
    summary = parse_junit_summary(junit_path)
    run_started_at = resolve_run_started_at(summary)
    print(f"  parsed {len(cases)} TestCase(s); run started_at={run_started_at}")

    print(f"→ Connecting to Weaviate at {args.weaviate_url}")
    client = _connect(args.weaviate_url, args.weaviate_api_key)

    try:
        # Idempotent — no-op if collections already exist with a compatible schema.
        ensure_test_run_collection(client)
        ensure_test_case_collection(
            client,
            vector_config=_build_vector_config(args.vectorizer, args.model2vec_inference_url),
        )

        # Upsert the TestRun.
        run_uuid = _run_uuid(
            args.repository, workflow_run_id, args.workflow_run_attempt, cfg.job_name
        )
        run_props = aggregate_run_properties(
            cases, meta, cfg, summary=summary, run_started_at=run_started_at
        )
        run_collection = client.collections.get(TEST_RUN)
        if run_collection.data.exists(uuid=run_uuid):
            run_collection.data.replace(uuid=run_uuid, properties=run_props)
            print(f"→ Replaced TestRun {run_uuid[:8]} (was already ingested)")
        else:
            run_collection.data.insert(properties=run_props, uuid=run_uuid)
            print(f"→ Inserted TestRun {run_uuid[:8]}")

        # Batch the cases.
        t0 = time.perf_counter()
        success, failed = ingest_test_cases(
            client,
            cases,
            run_uuid,
            repository=args.repository,
            workflow_run_id=workflow_run_id,
            workflow_run_attempt=args.workflow_run_attempt,
            job_name=cfg.job_name,
            run_started_at=run_started_at,
        )
        elapsed = time.perf_counter() - t0
        print(f"→ Ingested {success} TestCase(s) in {elapsed:.2f}s ({failed} failed)")

        # Summary
        failed_count = sum(1 for c in cases if c.status == "failed")
        skipped_count = sum(1 for c in cases if c.status == "skipped")
        passed_count = len(cases) - failed_count - skipped_count
        print()
        print(f"✓ Run summary: passed={passed_count} failed={failed_count} skipped={skipped_count}")
        print(f"  TestRun UUID: {run_uuid}")
        print(f"  Job:          {cfg.job_name}")
        print(f"  Branch:       {branch}  ({commit_hash[:8]})")
        print(f"  Trigger:      {args.trigger_type}")
        print(f"  Actor:        {actor}")
        print()
        print("→ Browse it at http://localhost:3030 (Test Explorer / Metrics / Semantic Search).")
        return 0 if failed == 0 else 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
