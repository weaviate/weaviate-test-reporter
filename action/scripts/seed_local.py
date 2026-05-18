"""Seed the local-k8s Weaviate with realistic synthetic CI history.

Designed for a demo: 10 TestRuns over the last 10 days, mixing pytest and
Go-test suites, with a realistic spread of failures (network timeouts,
assertion failures, OOM, race conditions). Each TestCase is vectorized
via the cluster's text2vec-model2vec module so the Semantic Search tab
returns sensible results out of the box.

Run from the action/ directory with the venv active:

    .venv/bin/python scripts/seed_local.py
"""

from __future__ import annotations

import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Allow running as a script without an editable install.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import weaviate
from weaviate.classes.init import Auth

from weaviate_test_reporter.ingest import _run_uuid, ingest_test_cases
from weaviate_test_reporter.parser import ParsedCase
from weaviate_test_reporter.schema import (
    TEST_CASE,
    TEST_RUN,
    ensure_test_case_collection,
    ensure_test_run_collection,
)
from weaviate_test_reporter.vectorization import build_test_case_vector_config

random.seed(0xc1)

# In-cluster model2vec endpoint that Weaviate itself reaches via DNS.
MODEL2VEC_IN_CLUSTER = "http://model2vec-inference.weaviate.svc.cluster.local.:8080"

REPO = "weaviate/weaviate-test-reporter"

# Realistic suite mix: 4 pytest e2e suites + 2 Go unit suites.
SUITES = [
    ("tests.e2e.test_backup", "pytest", "e2e-backup"),
    ("tests.e2e.test_replication", "pytest", "e2e-replication"),
    ("tests.e2e.test_multitenancy", "pytest", "e2e-multitenancy"),
    ("tests.e2e.test_rbac", "pytest", "e2e-rbac"),
    ("github.com/weaviate/weaviate/usecases/objects", "golang", "go-unit"),
    ("github.com/weaviate/weaviate/adapters/repos/db", "golang", "go-unit"),
]

# Pool of distinct failure modes, each with name/message/trace/type.
FAILURE_TEMPLATES = [
    {
        "name": "test_snapshot_restore_after_node_failure",
        "failure_type": "AssertionError",
        "message": "expected snapshot to exist on remote",
        "trace": (
            "Traceback (most recent call last):\n"
            '  File "tests/e2e/test_backup.py", line 142, in test_snapshot_restore_after_node_failure\n'
            "    assert snapshot.exists()\n"
            "AssertionError: expected snapshot to exist on remote s3://bucket/restore"
        ),
    },
    {
        "name": "test_async_replication_eventually_consistent",
        "failure_type": "TimeoutError",
        "message": "async replica did not converge within 30s",
        "trace": (
            "Traceback (most recent call last):\n"
            '  File "tests/e2e/test_replication.py", line 88, in test_async_replication_eventually_consistent\n'
            "    self.wait_for_convergence(timeout=30)\n"
            "TimeoutError: async replica did not converge within 30s\n"
            "  pending writes: 412 objects, last ack 28.4s ago"
        ),
    },
    {
        "name": "test_tenant_offload_under_memory_pressure",
        "failure_type": "ResourceError",
        "message": "OOMKilled while offloading shard tenant_42",
        "trace": (
            "TimeoutError: shard offload exceeded budget\n"
            "  shard=tenant_42 size=2.1GiB memory_limit=2GiB\n"
            "OOMKilled (137) — container ran out of memory at 2GiB limit"
        ),
    },
    {
        "name": "test_rbac_role_inheritance",
        "failure_type": "AssertionError",
        "message": "expected role 'editor' to inherit from 'viewer'",
        "trace": (
            "Traceback (most recent call last):\n"
            '  File "tests/e2e/test_rbac.py", line 67, in test_rbac_role_inheritance\n'
            "    assert 'viewer' in editor_role.parents\n"
            "AssertionError: expected role 'editor' to inherit from 'viewer'\n"
            "  got parents: []"
        ),
    },
    {
        "name": "TestShardCompaction_RaceFromConcurrentWrites",
        "failure_type": "DataRace",
        "message": "concurrent map write during compaction",
        "trace": (
            "WARNING: DATA RACE\n"
            "Write at 0x00c000148120 by goroutine 23:\n"
            "  github.com/weaviate/weaviate/adapters/repos/db.(*Shard).Compact\n"
            "      shard_compact.go:84\n"
            "Previous write by goroutine 41:\n"
            "      shard_write.go:142"
        ),
    },
    {
        "name": "TestObjectUpdate_VectorReindexed",
        "failure_type": "AssertionError",
        "message": "vector was not reindexed after update",
        "trace": (
            "    objects_test.go:412: vector should be reindexed after property change\n"
            "        expected: dim=384 norm≈1.0\n"
            "        got:      dim=384 norm=0.0 (stale)"
        ),
    },
    {
        "name": "test_multi_tenancy_isolation_under_load",
        "failure_type": "AssertionError",
        "message": "tenant A read returned objects from tenant B",
        "trace": (
            "Traceback (most recent call last):\n"
            '  File "tests/e2e/test_multitenancy.py", line 201, in test_multi_tenancy_isolation_under_load\n'
            "    assert all(o.tenant == 'A' for o in results)\n"
            "AssertionError: tenant A read returned 3 objects from tenant B"
        ),
    },
    {
        "name": "test_replica_promotion_during_network_partition",
        "failure_type": "TimeoutError",
        "message": "leader election did not complete within 15s",
        "trace": (
            "TimeoutError: raft leader election timeout\n"
            "  cluster has 3 nodes, network partition isolates node-2\n"
            "  no leader elected after 15s"
        ),
    },
]


def _now_minus(days_back: int, jitter_minutes: int = 30) -> datetime:
    base = datetime.now(timezone.utc) - timedelta(
        days=days_back, minutes=random.randint(0, jitter_minutes)
    )
    return base


def _gen_cases_for_run(run_idx: int, run_failure_count: int) -> list[ParsedCase]:
    """Generate ~20 cases per run with a controlled number of failures."""
    cases: list[ParsedCase] = []
    n_total = 18 + random.randint(-2, 4)
    fail_picks = random.sample(FAILURE_TEMPLATES, k=min(run_failure_count, len(FAILURE_TEMPLATES)))
    failed_indices = set(random.sample(range(n_total), k=run_failure_count))

    fail_iter = iter(fail_picks)
    for i in range(n_total):
        suite, framework, _job = random.choice(SUITES)
        if i in failed_indices:
            try:
                f = next(fail_iter)
            except StopIteration:
                f = random.choice(FAILURE_TEMPLATES)
            cases.append(ParsedCase(
                name=f["name"],
                test_suite=suite,
                framework=framework,
                status="failed",
                duration_ms=random.randint(500, 8_000),
                error_message=f["message"],
                stack_trace=f["trace"],
                failure_type=f["failure_type"],
            ))
        elif random.random() < 0.08:
            cases.append(ParsedCase(
                name=f"test_skipped_case_{run_idx}_{i}",
                test_suite=suite,
                framework=framework,
                status="skipped",
                duration_ms=0,
                error_message="feature flag off",
                stack_trace=None,
                failure_type=None,
            ))
        else:
            cases.append(ParsedCase(
                name=f"test_pass_case_{i:02d}",
                test_suite=suite,
                framework=framework,
                status="passed",
                duration_ms=random.randint(40, 900),
                error_message=None,
                stack_trace=None,
                failure_type=None,
            ))
    return cases


def _insert_run(client: weaviate.WeaviateClient, run_idx: int, cases: list[ParsedCase]):
    timestamp = _now_minus(days_back=10 - run_idx).isoformat()
    workflow_run_id = str(40_000 + run_idx)
    attempt = 1
    any_failed = any(c.status == "failed" for c in cases)
    status = "failure" if any_failed else "success"
    pr_number = (run_idx % 3) * 100 + 17 if run_idx % 2 == 0 else None
    trigger_type = "pull_request" if pr_number else random.choice(["push", "cron"])
    branch = (
        f"feature/run-{run_idx}-fix-flake"
        if trigger_type == "pull_request"
        else "main"
    )
    actor = random.choice(["alice", "bob", "carol", "dave", "weaviate-bot"])
    job_name = random.choice(["e2e-backup", "e2e-replication", "e2e-multitenancy", "go-unit", "e2e-rbac"])
    run_uuid = _run_uuid(REPO, workflow_run_id, attempt, job_name)

    props = {
        "run_id": f"ci/{job_name}#{workflow_run_id}.{attempt}",
        "repository": REPO,
        "branch": branch,
        "commit_hash": f"{random.randint(0, 0xfff_ffff):07x}{random.randint(0, 0xfff_ffff):07x}",
        "trigger_type": trigger_type,
        "status": status,
        "total_duration_ms": sum(c.duration_ms for c in cases),
        "timestamp": timestamp,
        "workflow_run_id": workflow_run_id,
        "workflow_run_attempt": attempt,
        "workflow_name": "ci",
        "job_name": job_name,
        "pr_number": pr_number,
        "actor": actor,
        "run_url": f"https://github.com/{REPO}/actions/runs/{workflow_run_id}/attempts/{attempt}",
    }

    run_collection = client.collections.get(TEST_RUN)
    if run_collection.data.exists(uuid=run_uuid):
        run_collection.data.replace(uuid=run_uuid, properties=props)
    else:
        run_collection.data.insert(properties=props, uuid=run_uuid)

    ingest_test_cases(
        client, cases, run_uuid,
        repository=REPO,
        workflow_run_id=workflow_run_id,
        workflow_run_attempt=attempt,
        job_name=job_name,
    )
    return run_uuid, status, len(cases)


def main() -> int:
    print("→ Connecting to local Weaviate at http://localhost:8080")
    api_key = os.environ.get("WEAVIATE_API_KEY", "").strip()
    auth = Auth.api_key(api_key) if api_key else None
    client = weaviate.connect_to_local(
        host="localhost",
        port=8080,
        auth_credentials=auth,
    )
    try:
        # Drop and recreate collections so re-running the seed is deterministic.
        for cls in (TEST_CASE, TEST_RUN):
            if client.collections.exists(cls):
                print(f"→ Dropping existing collection {cls}")
                client.collections.delete(cls)

        print("→ Creating TestRun (no vectorizer)")
        ensure_test_run_collection(client)

        print(
            "→ Creating TestCase with named vectors via text2vec-model2vec "
            f"(in-cluster: {MODEL2VEC_IN_CLUSTER})"
        )
        ensure_test_case_collection(
            client,
            vector_config=build_test_case_vector_config(
                vectorizer="text2vec-model2vec",
                model2vec_inference_url=MODEL2VEC_IN_CLUSTER,
            ),
        )

        # 10 runs across the last 10 days. The most recent has the most failures
        # so the dashboard tells a story ("today is on fire").
        failure_curve = [0, 1, 0, 2, 1, 0, 1, 3, 2, 5]
        total_cases = 0
        for i, failures in enumerate(failure_curve):
            cases = _gen_cases_for_run(i, run_failure_count=failures)
            run_uuid, status, n = _insert_run(client, i, cases)
            total_cases += n
            print(
                f"  • run {i:>2}: {status:<8} cases={n:<3} failures={failures} "
                f"uuid={run_uuid[:8]}"
            )

        print(f"\n✓ Seeded 10 TestRuns ({total_cases} TestCases) into Weaviate.")
        print("  Open the dashboard at http://localhost:3000 once the dev server is up.")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
