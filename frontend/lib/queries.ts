/**
 * Browser-side Weaviate queries (REST + GraphQL).
 *
 * Each function returns a Promise<typed payload>. The UI layer wraps these
 * with the useAsync hook so it doesn't have to thread loading/error state
 * manually.
 *
 * All user-controlled values flow through GraphQL variables, not string
 * concatenation, so escaping / injection is the runtime's problem.
 *
 * Why GraphQL specifically: see lib/weaviate-client.ts. The native v4 TS
 * client cannot run in the browser; GraphQL is the only stable
 * browser-accessible query surface today.
 */
import {
  COLLECTIONS,
  DEFAULT_TIMEOUTS_MS,
  graphql,
} from "./weaviate-client";
import type {
  DashboardKpis,
  TestCase,
  TestCaseStatus,
  TestRun,
  TestRunStatus,
} from "./types";

const RECENT_RUNS_LIMIT = 50;
const SEARCH_LIMIT = 20;

export const TARGET_VECTORS = ["stack_trace", "error_message", "name"] as const;
export type TargetVector = (typeof TARGET_VECTORS)[number];
export const DEFAULT_TARGET_VECTOR: TargetVector = "stack_trace";

// ---------- filter types ----------

export type RunFilters = {
  /** Free-text fragment matched (case-insensitive) against run_id, branch, actor, commit_hash. */
  search?: string;
  /** Repository property — multi-select. Empty/undefined = no filter. */
  repositories?: string[];
  /** Status property — multi-select. Empty/undefined = no filter. */
  statuses?: string[];
};

type WhereOperand = Record<string, unknown>;

function whereForRunFilters(filters: RunFilters): WhereOperand | null {
  const operands: WhereOperand[] = [];

  const term = filters.search?.trim();
  if (term) {
    // Weaviate's Like uses shell globs (* matches any chars).
    const wild = `*${term}*`;
    operands.push({
      operator: "Or",
      operands: ["run_id", "branch", "actor", "commit_hash"].map((path) => ({
        path: [path],
        operator: "Like",
        valueText: wild,
      })),
    });
  }
  if (filters.repositories?.length) {
    operands.push({
      operator: "Or",
      operands: filters.repositories.map((r) => ({
        path: ["repository"],
        operator: "Equal",
        valueText: r,
      })),
    });
  }
  if (filters.statuses?.length) {
    operands.push({
      operator: "Or",
      operands: filters.statuses.map((s) => ({
        path: ["status"],
        operator: "Equal",
        valueText: s,
      })),
    });
  }

  if (operands.length === 0) return null;
  if (operands.length === 1) return operands[0];
  return { operator: "And", operands };
}

// ---------- response shapes ----------

type GraphQLTestRun = {
  run_id: string;
  repository: string;
  branch: string;
  commit_hash: string;
  trigger_type: string;
  status: TestRunStatus;
  total_duration_ms: number;
  timestamp: string;
  workflow_run_id: string;
  workflow_run_attempt: number;
  workflow_name: string;
  job_name: string;
  pr_number: number | null;
  actor: string;
  run_url: string;
  _additional: { id: string };
};

type GraphQLTestCase = {
  name: string;
  test_suite: string;
  framework: string;
  status: TestCaseStatus;
  duration_ms: number;
  error_message: string | null;
  stack_trace: string | null;
  failure_type: string | null;
  _additional: {
    id: string;
    distance?: number;
  };
  belongsToRun?: Array<{ _additional: { id: string } }>;
};

function asTestRun(r: GraphQLTestRun): TestRun {
  return {
    uuid: r._additional.id,
    run_id: r.run_id ?? "",
    repository: r.repository ?? "",
    branch: r.branch ?? "",
    commit_hash: r.commit_hash ?? "",
    trigger_type: r.trigger_type ?? "",
    status: r.status,
    total_duration_ms: r.total_duration_ms ?? 0,
    timestamp: r.timestamp ?? "",
    workflow_run_id: r.workflow_run_id ?? "",
    workflow_run_attempt: r.workflow_run_attempt ?? 1,
    workflow_name: r.workflow_name ?? "",
    job_name: r.job_name ?? "",
    pr_number: r.pr_number ?? null,
    actor: r.actor ?? "",
    run_url: r.run_url ?? "",
  };
}

function asTestCase(c: GraphQLTestCase): TestCase {
  return {
    uuid: c._additional.id,
    name: c.name ?? "",
    test_suite: c.test_suite ?? "",
    framework: c.framework ?? "",
    status: c.status,
    duration_ms: c.duration_ms ?? 0,
    error_message: c.error_message ?? null,
    stack_trace: c.stack_trace ?? null,
    failure_type: c.failure_type ?? null,
    distance: c._additional.distance,
    belongsToRunUuid: c.belongsToRun?.[0]?._additional?.id,
  };
}

// ---------- queries ----------

export async function fetchRecentRuns(
  filters: RunFilters = {},
  limit = RECENT_RUNS_LIMIT,
): Promise<TestRun[]> {
  const where = whereForRunFilters(filters);
  // Weaviate quirks worked around here:
  //   1. `limit` as a GraphQL variable raises `interface {} is int64,
  //      not int` server-side. Interpolate it instead.
  //   2. `where: null` raises `interface {} is nil, not map[string]…`.
  //      Omit the argument entirely when there's no filter.
  //
  // Filter clauses (the user-controlled values) ARE proper variables
  // when present — protected from injection by JSON serialization.
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  const query = where
    ? /* GraphQL */ `
        query Runs($where: GetObjectsTestRunWhereInpObj!) {
          Get {
            ${COLLECTIONS.TEST_RUN}(
              limit: ${safeLimit}
              sort: [{ path: ["timestamp"], order: desc }]
              where: $where
            ) {
              run_id repository branch commit_hash trigger_type status
              total_duration_ms timestamp workflow_run_id workflow_run_attempt
              workflow_name job_name pr_number actor run_url
              _additional { id }
            }
          }
        }
      `
    : /* GraphQL */ `
        query Runs {
          Get {
            ${COLLECTIONS.TEST_RUN}(
              limit: ${safeLimit}
              sort: [{ path: ["timestamp"], order: desc }]
            ) {
              run_id repository branch commit_hash trigger_type status
              total_duration_ms timestamp workflow_run_id workflow_run_attempt
              workflow_name job_name pr_number actor run_url
              _additional { id }
            }
          }
        }
      `;
  const variables = where ? { where } : {};
  const data = await graphql<{ Get: Record<string, GraphQLTestRun[]> }>(
    query,
    variables,
  );
  return (data.Get[COLLECTIONS.TEST_RUN] ?? []).map(asTestRun);
}

/**
 * List the distinct values of a TestRun property + their occurrence counts.
 * Powers the filter-bar dropdowns.
 */
export async function fetchDistinctRunValues(
  property: "repository" | "branch" | "actor" | "status"
): Promise<Array<{ value: string; count: number }>> {
  const query = /* GraphQL */ `
    query DistinctRunValues($property: String!) {
      Aggregate {
        ${COLLECTIONS.TEST_RUN}(groupBy: [$property]) {
          meta { count }
          groupedBy { value }
        }
      }
    }
  `;
  type Resp = {
    Aggregate: {
      [k: string]: Array<{
        meta: { count: number };
        groupedBy: { value: string };
      }>;
    };
  };
  const data = await graphql<Resp>(query, { property });
  return (data.Aggregate[COLLECTIONS.TEST_RUN] ?? [])
    .map((g) => ({ value: g.groupedBy.value, count: g.meta.count }))
    .sort((a, b) => b.count - a.count);
}

export async function fetchCasesForRun(
  runUuid: string,
  opts: { failedOnly?: boolean; limit?: number } = {}
): Promise<TestCase[]> {
  const limit = opts.limit ?? 200;
  const operands: WhereOperand[] = [
    {
      path: ["belongsToRun", COLLECTIONS.TEST_RUN, "id"],
      operator: "Equal",
      valueText: runUuid,
    },
  ];
  if (opts.failedOnly) {
    operands.push({
      path: ["status"],
      operator: "Equal",
      valueText: "failed",
    });
  }
  const where: WhereOperand = { operator: "And", operands };

  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 5000));
  const query = /* GraphQL */ `
    query CasesForRun($where: GetObjectsTestCaseWhereInpObj!) {
      Get {
        ${COLLECTIONS.TEST_CASE}(limit: ${safeLimit}, where: $where) {
          name test_suite framework status duration_ms
          error_message stack_trace failure_type
          _additional { id }
        }
      }
    }
  `;
  const data = await graphql<{ Get: Record<string, GraphQLTestCase[]> }>(
    query,
    { where },
  );
  return (data.Get[COLLECTIONS.TEST_CASE] ?? []).map((c) => ({
    ...asTestCase(c),
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
  const limit = opts.limit ?? SEARCH_LIMIT;
  const targetVector = opts.targetVector ?? DEFAULT_TARGET_VECTOR;
  const where: WhereOperand | null = opts.failedOnly
    ? { path: ["status"], operator: "Equal", valueText: "failed" }
    : null;

  // Same Weaviate where-can't-be-null quirk as fetchRecentRuns.
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const selection = /* GraphQL */ `
    name test_suite framework status duration_ms
    error_message stack_trace failure_type
    _additional { id distance }
    belongsToRun {
      ... on ${COLLECTIONS.TEST_RUN} { _additional { id } }
    }
  `;
  const gql = where
    ? /* GraphQL */ `
        query Semantic(
          $concepts: [String!]!
          $where: GetObjectsTestCaseWhereInpObj!
          $targetVectors: [String!]
        ) {
          Get {
            ${COLLECTIONS.TEST_CASE}(
              limit: ${safeLimit}
              nearText: { concepts: $concepts, targetVectors: $targetVectors }
              where: $where
            ) { ${selection} }
          }
        }
      `
    : /* GraphQL */ `
        query Semantic(
          $concepts: [String!]!
          $targetVectors: [String!]
        ) {
          Get {
            ${COLLECTIONS.TEST_CASE}(
              limit: ${safeLimit}
              nearText: { concepts: $concepts, targetVectors: $targetVectors }
            ) { ${selection} }
          }
        }
      `;
  const variables: Record<string, unknown> = {
    concepts: [trimmed],
    targetVectors: [targetVector],
  };
  if (where) variables.where = where;
  const data = await graphql<{ Get: Record<string, GraphQLTestCase[]> }>(
    gql,
    variables,
    { timeoutMs: DEFAULT_TIMEOUTS_MS.search },
  );
  return (data.Get[COLLECTIONS.TEST_CASE] ?? []).map(asTestCase);
}

/**
 * Compute the dashboard KPIs.
 *
 * `sinceIso` (optional) restricts the aggregate to TestRuns whose
 * `timestamp` is on or after the given RFC3339 string. Defaulting to the
 * last 7 days keeps the global pass rate meaningful as data grows.
 */
export async function fetchDashboardKpis(
  sinceIso?: string,
): Promise<DashboardKpis> {
  const runTimestampWhere: WhereOperand | null = sinceIso
    ? {
        path: ["timestamp"],
        operator: "GreaterThanEqual",
        valueDate: sinceIso,
      }
    : null;
  // For TestCase we filter by belongsToRun ALL-paths reaching a run with
  // timestamp >= sinceIso. To keep this query simple we just apply the
  // same date filter on the TestCase's _creationTimeUnix (which we index
  // via inverted_index_config.index_timestamps).
  const caseCreationWhere: WhereOperand | null = sinceIso
    ? {
        path: ["_creationTimeUnix"],
        operator: "GreaterThanEqual",
        valueText: String(Date.parse(sinceIso)),
      }
    : null;

  const failedStatusOp: WhereOperand = {
    path: ["status"],
    operator: "Equal",
    valueText: "failed",
  };
  const failedSuiteWhere: WhereOperand = caseCreationWhere
    ? { operator: "And", operands: [failedStatusOp, caseCreationWhere] }
    : failedStatusOp;

  // Inline where: null can't be passed via variables (Weaviate quirk),
  // so we conditionally interpolate the where: argument. Weaviate's
  // GraphQL parser ALSO rejects empty parens — `TestRun()` raises
  // "Unexpected empty IN ()" — so when there's no where the collection
  // must be referenced bare: `TestRun { ... }`.
  const runCollectionArg = runTimestampWhere ? "(where: $runWhere)" : "";
  const runWhereDecl = runTimestampWhere
    ? "$runWhere: AggregateObjectsTestRunWhereInpObj"
    : "";
  const caseCollectionArg = caseCreationWhere ? "(where: $caseWhere)" : "";
  const caseWhereDecl = caseCreationWhere
    ? "$caseWhere: AggregateObjectsTestCaseWhereInpObj"
    : "";
  const queryDecls = [
    runWhereDecl,
    caseWhereDecl,
    "$failedSuiteWhere: AggregateObjectsTestCaseWhereInpObj!",
  ]
    .filter(Boolean)
    .join(",");
  const gql = /* GraphQL */ `
    query Kpis(${queryDecls}) {
      runAgg: Aggregate {
        ${COLLECTIONS.TEST_RUN}${runCollectionArg} {
          meta { count }
          total_duration_ms { mean }
        }
      }
      caseAgg: Aggregate {
        ${COLLECTIONS.TEST_CASE}${caseCollectionArg} {
          meta { count }
          status { topOccurrences { value occurs } }
        }
      }
      failedBySuite: Aggregate {
        ${COLLECTIONS.TEST_CASE}(
          where: $failedSuiteWhere
          groupBy: "test_suite"
        ) {
          meta { count }
          groupedBy { path value }
        }
      }
    }
  `;

  type AggregateNumeric = { mean: number | null };
  type StatusBucket = { value: string; occurs: number };
  type FailedGroup = {
    meta: { count: number };
    groupedBy: { path: string[]; value: string };
  };
  type Resp = {
    runAgg: {
      [k: string]: Array<{
        meta: { count: number };
        total_duration_ms: AggregateNumeric;
      }>;
    };
    caseAgg: {
      [k: string]: Array<{
        meta: { count: number };
        status: { topOccurrences: StatusBucket[] };
      }>;
    };
    failedBySuite: { [k: string]: FailedGroup[] };
  };

  const kpiVars: Record<string, unknown> = { failedSuiteWhere };
  if (runTimestampWhere) kpiVars.runWhere = runTimestampWhere;
  if (caseCreationWhere) kpiVars.caseWhere = caseCreationWhere;
  const data = await graphql<Resp>(gql, kpiVars);
  const runRow = data.runAgg[COLLECTIONS.TEST_RUN]?.[0];
  const caseRow = data.caseAgg[COLLECTIONS.TEST_CASE]?.[0];
  const buckets = caseRow?.status?.topOccurrences ?? [];
  const totalCases =
    caseRow?.meta?.count ?? buckets.reduce((s, b) => s + b.occurs, 0);
  const passed = buckets.find((b) => b.value === "passed")?.occurs ?? 0;
  const passRate = totalCases > 0 ? passed / totalCases : 0;

  const failedGroups = data.failedBySuite[COLLECTIONS.TEST_CASE] ?? [];
  const top = failedGroups
    .map((g) => ({ suite: g.groupedBy.value, count: g.meta.count }))
    .sort((a, b) => b.count - a.count)[0];

  return {
    passRate,
    avgRunDurationMs: Math.round(runRow?.total_duration_ms?.mean ?? 0),
    topFailingSuite: top ?? null,
    totalRuns: runRow?.meta?.count ?? 0,
    totalCases,
  };
}

export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
