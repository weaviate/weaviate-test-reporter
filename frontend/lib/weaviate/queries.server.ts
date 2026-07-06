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
  bucketRunsByDay,
  detectExecutedDrops,
  buildTestHistory,
  type FlakeRow,
  type StatusGroup,
  type RunRow,
  type TrendPoint,
  type TrendRunRow,
  type ExecutedDrop,
  type ExecutedDropRow,
  type TestHistory,
  type TestHistoryPoint,
} from "../analysis";
import type {
  DashboardKpis,
  RunFilters,
  TestCase,
  TestCaseStatus,
  TestRun,
  TestRunStatus,
  TrendFilters,
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
  tests_failed: number;
  tests_skipped: number;
  tests_errors: number;
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
  // WS3 R3: denormalized run identity (flakes/history scope without a ref hop).
  version_minor: string;
  job_name: string;
  branch: string;
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
// Trend charts page the same rows (windowed by started_at) and bucket by day.
const TREND_PAGE_SIZE = 1000;
const TREND_MAX_ROWS = 100_000;
// One test's history — bounded (one case per run) but paginate to be safe.
const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_ROWS = 50_000;

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
  references?: Record<
    string,
    { objects?: Array<{ uuid: string; properties?: Record<string, unknown> }> }
  >;
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
    // Real run start (WS1 D1); the action always sets it (falls back to ingest
    // time), so a re-ingested cluster never has an empty started_at.
    started_at: normalizeDate(p.started_at),
    tests_total: (p.tests_total as number) ?? 0,
    tests_passed: (p.tests_passed as number) ?? 0,
    tests_failed: (p.tests_failed as number) ?? 0,
    tests_skipped: (p.tests_skipped as number) ?? 0,
    tests_errors: (p.tests_errors as number) ?? 0,
    workflow_run_id: (p.workflow_run_id as string) ?? "",
    workflow_run_attempt: (p.workflow_run_attempt as number) ?? 1,
    workflow_name: (p.workflow_name as string) ?? "",
    job_name: (p.job_name as string) ?? "",
    pr_number: (p.pr_number as number | null) ?? null,
    actor: (p.actor as string) ?? "",
    run_url: (p.run_url as string) ?? "",
    // Enforce the documented invariant here (not at every call site): job_url is
    // never empty when a run_url exists — it falls back to the run+attempt URL.
    job_url: (p.job_url as string) || (p.run_url as string) || "",
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
    // Order by real run start (WS1 D1), not ingest time — a run reported hours
    // after it ran shouldn't jump ahead of runs that actually started later.
    // Secondary key (ingest `timestamp`) breaks ties deterministically when
    // parallel matrix jobs share the same run-start, so the list doesn't flicker
    // between refreshes.
    sort: runs.sort
      .byProperty("started_at", false)
      .byProperty("timestamp", false),
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
        "tests_skipped",
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
        tests_skipped: (p.tests_skipped as number) ?? 0,
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
        runs.metrics.aggregate("tests_skipped").integer(["sum"]),
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
      tests_skipped?: { sum?: number | null };
    };
  };
  return deriveKpis({
    totalRuns: runAggR.totalCount ?? 0,
    avgDurationMean: runAggR.properties?.total_duration_ms?.mean ?? null,
    totalTests: runAggR.properties?.tests_total?.sum ?? 0,
    passedTests: runAggR.properties?.tests_passed?.sum ?? 0,
    skippedTests: runAggR.properties?.tests_skipped?.sum ?? 0,
    failedSuiteGroups: mapGroups(failedSuite).map((g) => ({
      suite: g.value,
      count: g.count,
    })),
  });
}

/**
 * Per-day trend series for the dashboard charts (WS2 H2). Windowed by real run
 * start (started_at, WS1 D1) so it lines up with the KPI tiles above it. Pages
 * the actual TestRun rows and buckets them in a pure function — deterministic,
 * unlike Weaviate's approximate date-grouped Aggregate.
 */
export async function fetchRunTrend(
  sinceIso?: string,
  filters: TrendFilters = {},
): Promise<TrendPoint[]> {
  const client = await getClient();
  const runs = runsCol(client);
  const since = sinceIso ? new Date(sinceIso) : undefined;

  // Window (started_at) AND any repo/branch/version slice — same filter algebra
  // as fetchRecentRuns.
  const ops: FilterValue[] = [];
  if (since) {
    ops.push(runs.filter.byProperty("started_at").greaterOrEqual(since));
  }
  if (filters.repositories?.length) {
    ops.push(anyEqual(runs, "repository", filters.repositories));
  }
  if (filters.branches?.length) {
    ops.push(anyEqual(runs, "branch", filters.branches));
  }
  if (filters.versionMinors?.length) {
    ops.push(anyEqual(runs, "version_minor", filters.versionMinors));
  }
  const filter =
    ops.length === 0
      ? undefined
      : ops.length === 1
        ? ops[0]
        : Filters.and(...ops);

  const rows: TrendRunRow[] = [];
  let offset = 0;
  while (rows.length < TREND_MAX_ROWS) {
    const pageSize = Math.min(TREND_PAGE_SIZE, TREND_MAX_ROWS - rows.length);
    const res = await runs.query.fetchObjects({
      limit: pageSize,
      offset,
      filters: filter,
      // Creation-time order is a stable total order → offset pagination stays
      // correct across pages. Bucketing doesn't depend on the order.
      sort: runs.sort.byCreationTime(true),
      returnProperties: [
        "started_at",
        "status",
        "total_duration_ms",
        "tests_total",
        "tests_passed",
        "tests_failed",
        "tests_skipped",
        "tests_errors",
      ],
    });
    const page = res.objects as unknown as RawObject[];
    for (const o of page) {
      const p = o.properties;
      rows.push({
        started_at: normalizeDate(p.started_at),
        status: (p.status as string) ?? "",
        total_duration_ms: (p.total_duration_ms as number) ?? 0,
        tests_total: (p.tests_total as number) ?? 0,
        tests_passed: (p.tests_passed as number) ?? 0,
        tests_failed: (p.tests_failed as number) ?? 0,
        tests_skipped: (p.tests_skipped as number) ?? 0,
        tests_errors: (p.tests_errors as number) ?? 0,
      });
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return bucketRunsByDay(rows);
}

/**
 * Expected-vs-executed drops (WS2 H3). Pages the windowed TestRun rows and hands
 * them to the pure `detectExecutedDrops` — which flags jobs whose latest run ran
 * meaningfully fewer tests than the run before. Windowed by started_at so a job
 * needs at least two runs in the range to be evaluated.
 */
export async function fetchExecutedDrops(
  sinceIso?: string,
): Promise<ExecutedDrop[]> {
  const client = await getClient();
  const runs = runsCol(client);
  const since = sinceIso ? new Date(sinceIso) : undefined;
  const filter = since
    ? runs.filter.byProperty("started_at").greaterOrEqual(since)
    : undefined;

  const rows: ExecutedDropRow[] = [];
  let offset = 0;
  while (rows.length < TREND_MAX_ROWS) {
    const pageSize = Math.min(TREND_PAGE_SIZE, TREND_MAX_ROWS - rows.length);
    const res = await runs.query.fetchObjects({
      limit: pageSize,
      offset,
      filters: filter,
      sort: runs.sort.byCreationTime(true),
      returnProperties: [
        "repository",
        "job_name",
        "version_minor",
        "started_at",
        "tests_total",
        "tests_skipped",
        "run_id",
        "job_url",
        "run_url",
      ],
    });
    const page = res.objects as unknown as RawObject[];
    for (const o of page) {
      const p = o.properties;
      rows.push({
        repository: (p.repository as string) ?? "",
        job_name: (p.job_name as string) ?? "",
        version_minor: (p.version_minor as string | null) ?? null,
        started_at: normalizeDate(p.started_at),
        tests_total: (p.tests_total as number) ?? 0,
        tests_skipped: (p.tests_skipped as number) ?? 0,
        run_id: (p.run_id as string) ?? "",
        job_url: (p.job_url as string) || (p.run_url as string) || "",
      });
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return detectExecutedDrops(rows);
}

/**
 * One test's full history across runs (WS3 R1). Fetches every `TestCase` row for
 * a `(test_suite, name)` — ordered by real run start (run_started_at, WS1 D1) —
 * and pulls each run's version / branch / status / CI link through the
 * `belongsToRun` cross-reference, then shapes it with the pure `buildTestHistory`.
 */
export async function fetchTestHistory(
  testSuite: string,
  name: string,
): Promise<TestHistory> {
  const client = await getClient();
  const cases = casesCol(client);

  const filter = Filters.and(
    cases.filter.byProperty("test_suite").equal(testSuite),
    cases.filter.byProperty("name").equal(name),
  );

  const points: TestHistoryPoint[] = [];
  let framework = "";
  let offset = 0;
  while (points.length < HISTORY_MAX_ROWS) {
    const pageSize = Math.min(
      HISTORY_PAGE_SIZE,
      HISTORY_MAX_ROWS - points.length,
    );
    const res = await cases.query.fetchObjects({
      limit: pageSize,
      offset,
      filters: filter,
      sort: cases.sort.byProperty("run_started_at", true),
      // version_minor / branch / job_name are denormalized onto the case
      // (WS3 R3) — read them directly. The belongsToRun ref stays only for the
      // run-level per-point details we did NOT denormalize (run status / id /
      // CI URL); history is a single-test query, so the ref is cheap here.
      returnProperties: [
        "status",
        "framework",
        "run_started_at",
        "version_minor",
        "branch",
        "job_name",
        "error_message",
        "failure_type",
        "duration_ms",
      ],
      returnReferences: [
        {
          linkOn: "belongsToRun",
          returnProperties: ["status", "run_id", "run_url", "job_url"],
        },
      ],
    });
    const page = res.objects as unknown as RawObject[];
    for (const o of page) {
      const p = o.properties;
      if (!framework) framework = (p.framework as string) ?? "";
      const rp = o.references?.belongsToRun?.objects?.[0]?.properties ?? {};
      points.push({
        status: p.status as TestCaseStatus,
        runStartedAt: normalizeDate(p.run_started_at),
        versionMinor: (p.version_minor as string | null) ?? null,
        branch: (p.branch as string | null) ?? null,
        jobName: (p.job_name as string) ?? "",
        runStatus: (rp.status as string) ?? "",
        runId: (rp.run_id as string) ?? "",
        jobUrl: (rp.job_url as string) || (rp.run_url as string) || "",
        errorMessage: (p.error_message as string | null) ?? null,
        failureType: (p.failure_type as string | null) ?? null,
        durationMs: (p.duration_ms as number) ?? 0,
      });
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return buildTestHistory({ testSuite, name, framework }, points);
}

export async function fetchFlakyTests(
  window: FlakesWindow,
  opts: { minRuns?: number } = {},
): Promise<FlakyTest[]> {
  const client = await getClient();
  // Bulk flakiness scan reads at the default ONE consistency, NOT the QUORUM
  // used for the /versions pass-rate. Flakes is a trailing-window trend, so a
  // read lagging the very latest run by a replica-hop is fine — whereas QUORUM
  // makes every read in a large multi-page scan wait for a replica majority,
  // a real latency multiplier here.
  const cases = client.collections.get<CaseProps>(COLLECTIONS.TEST_CASE);
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
  // Sort by (test_suite, name, run_started_at). run_started_at ALONE is NOT
  // safe: EVERY case in a run shares that timestamp, so a single-key sort makes
  // huge tie-groups and offset pagination goes unstable across page boundaries
  // — cases get skipped/duplicated and run counts inflate. The (suite, name)
  // keys make the order near-unique per row so pagination stays stable;
  // computeFlaky only needs each group chronological, which the trailing
  // run_started_at key provides.
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
      // version_minor + job_name are denormalized onto the case (WS3 R3), so
      // flakiness groups per (suite, name, version, job) from a plain property
      // scan — no belongsToRun hop, no run-map join.
      returnProperties: [
        "name",
        "test_suite",
        "framework",
        "status",
        "version_minor",
        "job_name",
      ],
    });
    const page = res.objects as unknown as RawObject[];
    for (const o of page) {
      const p = o.properties;
      rows.push({
        test_suite: (p.test_suite as string) ?? "",
        name: (p.name as string) ?? "",
        framework: (p.framework as string) ?? "",
        version_minor: (p.version_minor as string | null) ?? null,
        job_name: (p.job_name as string) ?? "",
        status: p.status as TestCaseStatus,
      });
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return computeFlaky(rows, minRuns);
}
