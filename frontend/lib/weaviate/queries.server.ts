import "server-only";
import {
  Filters,
  type FilterValue,
  type CrossReference,
  type WeaviateClient,
} from "weaviate-client";
import { getClient } from "./client";
import {
  COLLECTIONS,
  RECENT_RUNS_LIMIT,
  SEARCH_LIMIT,
  CASES_LIMIT,
  DEFAULT_TARGET_VECTOR,
  type TargetVector,
  type FlakesWindow,
} from "../constants";
import {
  isoDaysAgo,
  computeFlaky,
  deriveKpis,
  rollupRunsByMinor,
  type FlakeRow,
  type StatusGroup,
  type RunRow,
} from "../analysis";
import type {
  DashboardKpis,
  RunFilters,
  TestCase,
  TestCaseStatus,
  TestRun,
  TestRunStatus,
  VersionRollup,
  FlakyTest,
} from "../types";

/**
 * Server-side Weaviate queries via the official TypeScript client (gRPC/REST).
 *
 * This is the parity-preserving replacement for the old browser GraphQL layer.
 * Each function reproduces the exact semantics of its `lib/queries.ts`
 * predecessor; the pure derivations live in `lib/analysis.ts`. Route handlers
 * call these and return the results as JSON.
 */

/**
 * Property generics for the collections. These drive the client's typed
 * property/sort/groupBy/reference builders (so `sort.byProperty("timestamp")`
 * and `filter.byRef("belongsToRun")` typecheck). Nullability is intentionally
 * omitted here — these types only gate filter/sort key names and value types;
 * the real null handling happens in `asTestRun` / `asTestCase`. `timestamp` is
 * a `date` property, surfaced by the client as a JS `Date`.
 */
type RunProps = {
  run_id: string;
  repository: string;
  branch: string;
  commit_hash: string;
  trigger_type: string;
  status: string;
  total_duration_ms: number;
  timestamp: Date;
  started_at: Date;
  tests_total: number;
  tests_passed: number;
  workflow_run_id: string;
  workflow_run_attempt: number;
  workflow_name: string;
  job_name: string;
  pr_number: number;
  actor: string;
  run_url: string;
  job_url: string;
  version_full: string;
  version_patch: string;
  version_minor: string;
};
type CaseProps = {
  name: string;
  test_suite: string;
  framework: string;
  status: string;
  duration_ms: number;
  error_message: string;
  stack_trace: string;
  failure_type: string;
  run_started_at: Date;
  belongsToRun: CrossReference<RunProps>;
};

// Group aggregations: cap groups generously (distinct repos/statuses/versions
// /suites are small in practice; the old GraphQL groupBy was unbounded).
const GROUP_LIMIT = 1000;
// Flakes pagination — mirrors the old client loop. Page through raw rows,
// stop on a partial page or once the hard ceiling is reached.
const FLAKES_PAGE_SIZE = 5000;
const FLAKES_MAX_ROWS = 200_000;
// Version rollup pages actual TestRun rows (exact, deterministic counts) —
// see rollupRunsByMinor for why we don't use approximate Aggregate groupBy.
const VERSION_PAGE_SIZE = 1000;
const VERSION_MAX_ROWS = 100_000;

function clamp(n: number, lo: number, hi: number): number {
  // Non-finite input (NaN/Infinity from a bad query param) falls back to the
  // lower bound rather than propagating NaN into the query.
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(Math.floor(n), hi));
}

// Read at QUORUM consistency. The cluster is multi-node; with the default ONE
// consistency, consecutive reads hit different replicas whose state can differ
// (async replication lag / in-flight ingestion), so counts — and the /versions
// pass rate — flicker between refreshes. QUORUM returns a majority-agreed
// snapshot, making reads deterministic.
function runsCol(client: WeaviateClient) {
  return client.collections
    .get<RunProps>(COLLECTIONS.TEST_RUN)
    .withConsistency("QUORUM");
}
function casesCol(client: WeaviateClient) {
  return client.collections
    .get<CaseProps>(COLLECTIONS.TEST_CASE)
    .withConsistency("QUORUM");
}

// ---------- result mapping ----------

type RawObject = {
  uuid: string;
  properties: Record<string, unknown>;
  metadata?: { distance?: number };
  references?: Record<string, { objects?: Array<{ uuid: string }> }>;
};

function asTestRun(o: RawObject): TestRun {
  const p = o.properties;
  return {
    uuid: o.uuid,
    run_id: (p.run_id as string) ?? "",
    repository: (p.repository as string) ?? "",
    branch: (p.branch as string) ?? "",
    commit_hash: (p.commit_hash as string) ?? "",
    trigger_type: (p.trigger_type as string) ?? "",
    status: p.status as TestRunStatus,
    total_duration_ms: (p.total_duration_ms as number) ?? 0,
    timestamp: normalizeDate(p.timestamp),
    workflow_run_id: (p.workflow_run_id as string) ?? "",
    workflow_run_attempt: (p.workflow_run_attempt as number) ?? 1,
    workflow_name: (p.workflow_name as string) ?? "",
    job_name: (p.job_name as string) ?? "",
    pr_number: (p.pr_number as number | null) ?? null,
    actor: (p.actor as string) ?? "",
    run_url: (p.run_url as string) ?? "",
    job_url: (p.job_url as string) ?? "",
    version_full: (p.version_full as string | null) ?? null,
    version_patch: (p.version_patch as string | null) ?? null,
    version_minor: (p.version_minor as string | null) ?? null,
  };
}

function asTestCase(o: RawObject): TestCase {
  const p = o.properties;
  return {
    uuid: o.uuid,
    name: (p.name as string) ?? "",
    test_suite: (p.test_suite as string) ?? "",
    framework: (p.framework as string) ?? "",
    status: p.status as TestCaseStatus,
    duration_ms: (p.duration_ms as number) ?? 0,
    error_message: (p.error_message as string | null) ?? null,
    stack_trace: (p.stack_trace as string | null) ?? null,
    failure_type: (p.failure_type as string | null) ?? null,
    distance: o.metadata?.distance,
    belongsToRunUuid: o.references?.belongsToRun?.objects?.[0]?.uuid,
  };
}

/** The TS client returns `date` properties as JS `Date`; the UI expects the
 *  ISO string the old GraphQL layer produced. */
function normalizeDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return (v as string) ?? "";
}

function mapGroups(
  groups: Array<{ groupedBy: { value: unknown }; totalCount: number }>,
): StatusGroup[] {
  return groups.map((g) => ({
    value: String(g.groupedBy.value),
    count: g.totalCount,
  }));
}

// ---------- queries ----------

export async function fetchRecentRuns(
  filters: RunFilters = {},
  limit = RECENT_RUNS_LIMIT,
): Promise<TestRun[]> {
  const client = await getClient();
  const runs = runsCol(client);
  const safeLimit = clamp(limit, 1, 1000);

  const ops: FilterValue[] = [];
  const term = filters.search?.trim();
  if (term) {
    const w = `*${term}*`;
    ops.push(
      Filters.or(
        runs.filter.byProperty("run_id").like(w),
        runs.filter.byProperty("branch").like(w),
        runs.filter.byProperty("actor").like(w),
        runs.filter.byProperty("commit_hash").like(w),
      ),
    );
  }
  if (filters.repositories?.length) {
    ops.push(anyEqual(runs, "repository", filters.repositories));
  }
  if (filters.statuses?.length) {
    ops.push(anyEqual(runs, "status", filters.statuses));
  }
  if (filters.versionMinors?.length) {
    ops.push(anyEqual(runs, "version_minor", filters.versionMinors));
  }
  if (filters.versionFulls?.length) {
    ops.push(anyEqual(runs, "version_full", filters.versionFulls));
  }
  const filter =
    ops.length === 0
      ? undefined
      : ops.length === 1
        ? ops[0]
        : Filters.and(...ops);

  const res = await runs.query.fetchObjects({
    limit: safeLimit,
    sort: runs.sort.byProperty("timestamp", false),
    filters: filter,
  });
  return (res.objects as unknown as RawObject[]).map(asTestRun);
}

function anyEqual(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  col: any,
  prop: string,
  values: string[],
): FilterValue {
  const parts = values.map((v) => col.filter.byProperty(prop).equal(v));
  return parts.length === 1 ? parts[0] : Filters.or(...parts);
}

export async function fetchDistinctRunValues(
  property:
    | "repository"
    | "branch"
    | "actor"
    | "status"
    | "version_full"
    | "version_minor",
): Promise<Array<{ value: string; count: number }>> {
  const client = await getClient();
  const runs = runsCol(client);
  const result = await runs.aggregate.groupBy.overAll({
    groupBy: { property, limit: GROUP_LIMIT },
  });
  return mapGroups(result).sort((a, b) => b.count - a.count);
}

export async function fetchVersionRollup(): Promise<VersionRollup[]> {
  const client = await getClient();
  const runs = runsCol(client);

  // Count actual TestRun rows (not Aggregate groupBy, which is approximate and
  // made the pass rate flicker between refreshes). Only three small fields per
  // row are fetched; a stable sort keeps offset pagination correct.
  const rows: RunRow[] = [];
  let offset = 0;
  while (rows.length < VERSION_MAX_ROWS) {
    const pageSize = Math.min(
      VERSION_PAGE_SIZE,
      VERSION_MAX_ROWS - rows.length,
    );
    const res = await runs.query.fetchObjects({
      limit: pageSize,
      offset,
      sort: runs.sort.byCreationTime(true),
      returnProperties: [
        "version_minor",
        "version_patch",
        "status",
        "tests_total",
        "tests_passed",
      ],
    });
    const page = res.objects as unknown as RawObject[];
    for (const o of page) {
      const p = o.properties;
      rows.push({
        version_minor: (p.version_minor as string | null) ?? null,
        version_patch: (p.version_patch as string | null) ?? null,
        status: (p.status as string) ?? "",
        tests_total: (p.tests_total as number) ?? 0,
        tests_passed: (p.tests_passed as number) ?? 0,
      });
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return rollupRunsByMinor(rows);
}

export async function fetchCasesForRun(
  runUuid: string,
  opts: { failedOnly?: boolean; limit?: number } = {},
): Promise<TestCase[]> {
  const client = await getClient();
  const cases = casesCol(client);
  const safeLimit = clamp(opts.limit ?? CASES_LIMIT, 1, 5000);

  const belongs = cases.filter.byRef("belongsToRun").byId().equal(runUuid);
  const filter = opts.failedOnly
    ? Filters.and(belongs, cases.filter.byProperty("status").equal("failed"))
    : belongs;

  const res = await cases.query.fetchObjects({
    limit: safeLimit,
    filters: filter,
  });
  return (res.objects as unknown as RawObject[]).map((o) => ({
    ...asTestCase(o),
    belongsToRunUuid: runUuid,
  }));
}

export async function semanticSearch(
  query: string,
  opts: {
    limit?: number;
    failedOnly?: boolean;
    targetVector?: TargetVector;
  } = {},
): Promise<TestCase[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const client = await getClient();
  const cases = casesCol(client);
  const limit = clamp(opts.limit ?? SEARCH_LIMIT, 1, 100);
  const targetVector = opts.targetVector ?? DEFAULT_TARGET_VECTOR;
  const filter = opts.failedOnly
    ? cases.filter.byProperty("status").equal("failed")
    : undefined;

  const res = await cases.query.nearText(trimmed, {
    limit,
    targetVector,
    filters: filter,
    returnMetadata: ["distance"],
    returnReferences: [{ linkOn: "belongsToRun" }],
  });
  return (res.objects as unknown as RawObject[]).map(asTestCase);
}

export async function fetchDashboardKpis(
  sinceIso?: string,
): Promise<DashboardKpis> {
  const client = await getClient();
  const runs = runsCol(client);
  const cases = casesCol(client);
  const since = sinceIso ? new Date(sinceIso) : undefined;

  // Window by the real run start (started_at / run_started_at, WS1 D1), not
  // ingest time — so "last 7 days" means when the tests actually ran.
  const runFilter = since
    ? runs.filter.byProperty("started_at").greaterOrEqual(since)
    : undefined;
  const caseWindow = since
    ? cases.filter.byProperty("run_started_at").greaterOrEqual(since)
    : undefined;
  const failedOp = cases.filter.byProperty("status").equal("failed");
  const failedFilter = caseWindow
    ? Filters.and(failedOp, caseWindow)
    : failedOp;

  // Pass rate + totals come from summing the run-level counts (TestRun.tests_*,
  // WS1 D2) — no full TestCase scan. Only the top-failing-suite still needs a
  // (filtered) TestCase aggregate.
  const [runAgg, failedSuite] = await Promise.all([
    runs.aggregate.overAll({
      filters: runFilter,
      returnMetrics: [
        runs.metrics.aggregate("total_duration_ms").integer(["mean"]),
        runs.metrics.aggregate("tests_total").integer(["sum"]),
        runs.metrics.aggregate("tests_passed").integer(["sum"]),
      ],
    }),
    cases.aggregate.groupBy.overAll({
      filters: failedFilter,
      groupBy: { property: "test_suite", limit: GROUP_LIMIT },
    }),
  ]);

  // AggregateResult nests metrics under `.properties[propName]`; `totalCount`
  // is top-level.
  const runAggR = runAgg as unknown as {
    totalCount?: number;
    properties?: {
      total_duration_ms?: { mean?: number | null };
      tests_total?: { sum?: number | null };
      tests_passed?: { sum?: number | null };
    };
  };
  return deriveKpis({
    totalRuns: runAggR.totalCount ?? 0,
    avgDurationMean: runAggR.properties?.total_duration_ms?.mean ?? null,
    totalTests: runAggR.properties?.tests_total?.sum ?? 0,
    passedTests: runAggR.properties?.tests_passed?.sum ?? 0,
    failedSuiteGroups: mapGroups(failedSuite).map((g) => ({
      suite: g.value,
      count: g.count,
    })),
  });
}

export async function fetchFlakyTests(
  window: FlakesWindow,
  opts: { minRuns?: number } = {},
): Promise<FlakyTest[]> {
  const client = await getClient();
  const cases = casesCol(client);
  const days = window === "7d" ? 7 : 30;
  const since = new Date(isoDaysAgo(days));
  // `?? 3` wouldn't catch NaN (only null/undefined), so guard for finiteness.
  const minRuns = Number.isFinite(opts.minRuns) ? (opts.minRuns as number) : 3;

  const windowFilter = Filters.and(
    // Window by the real run start (run_started_at, WS1 D1), not object
    // creation time — out-of-order / backfilled ingestion must not scramble
    // each test's chronological status sequence.
    cases.filter.byProperty("run_started_at").greaterOrEqual(since),
    // Skipped cases carry no flakiness signal; exclude them server-side.
    Filters.or(
      cases.filter.byProperty("status").equal("passed"),
      cases.filter.byProperty("status").equal("failed"),
    ),
  );
  // Stable sort across pages so each (suite, name) sequence stays contiguous
  // and in true run order when pages are concatenated.
  const sort = cases.sort
    .byProperty("test_suite", true)
    .byProperty("name", true)
    .byProperty("run_started_at", true);

  const rows: FlakeRow[] = [];
  let offset = 0;
  while (rows.length < FLAKES_MAX_ROWS) {
    const pageSize = Math.min(FLAKES_PAGE_SIZE, FLAKES_MAX_ROWS - rows.length);
    const res = await cases.query.fetchObjects({
      limit: pageSize,
      offset,
      filters: windowFilter,
      sort,
      returnProperties: ["name", "test_suite", "framework", "status"],
    });
    const page = res.objects as unknown as RawObject[];
    for (const o of page) {
      const p = o.properties;
      rows.push({
        test_suite: (p.test_suite as string) ?? "",
        name: (p.name as string) ?? "",
        framework: (p.framework as string) ?? "",
        status: p.status as TestCaseStatus,
      });
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return computeFlaky(rows, minRuns);
}
