/**
 * Pure post-processing for the dashboard's derived views.
 *
 * These functions take already-fetched plain data and compute the shapes the
 * UI consumes. They contain ZERO Weaviate / network / Node dependencies, so
 * they're cheap to unit-test and identical in behaviour to the pre-migration
 * GraphQL path (the algorithms were lifted verbatim from the old queries.ts).
 *
 * The server query layer (`lib/weaviate/queries.server.ts`) fetches raw rows /
 * aggregate groups via the TS client, maps them into these plain inputs, and
 * calls these functions.
 */
import type {
  TestCaseStatus,
  FlakyTest,
  DashboardKpis,
  VersionRollup,
} from "./types";

/** RFC3339 timestamp for 00:00:00 UTC, `days` ago. */
export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ---------- flakes ----------

export const FLAKES_RECENT_STATUSES = 20;
// `__SEP__` cannot appear in a JUnit `name` / `classname` (those are XML
// attribute values), so this is a collision-free group-key delimiter. A space
// would NOT be safe — pytest parametrize ids like `test_x[a, b]` contain them.
export const FLAKES_KEY_SEP = "__SEP__";

export type FlakeRow = {
  test_suite: string;
  name: string;
  framework: string;
  status: TestCaseStatus;
};

/**
 * Group rows by `(test_suite, name)` and compute per-test flakiness.
 *
 * Rows MUST already be ordered by `(test_suite, name, creationTime)` so each
 * test's status sequence is contiguous and chronological — the caller fetches
 * them with exactly that sort. `flakiness_score = transitions / (runs - 1)`.
 * Tests with fewer than `minRuns` observations, or zero status transitions
 * (all-passed / all-failed), are dropped.
 */
export function computeFlaky(rows: FlakeRow[], minRuns = 3): FlakyTest[] {
  type Acc = {
    test_suite: string;
    name: string;
    framework: string;
    statuses: TestCaseStatus[];
  };
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    const key = `${r.test_suite}${FLAKES_KEY_SEP}${r.name}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        test_suite: r.test_suite,
        name: r.name,
        framework: r.framework,
        statuses: [],
      };
      groups.set(key, acc);
    }
    acc.statuses.push(r.status);
  }

  const out: FlakyTest[] = [];
  for (const g of groups.values()) {
    const total = g.statuses.length;
    if (total < minRuns) continue;
    let transitions = 0;
    let passed = 0;
    let failed = 0;
    for (let i = 0; i < g.statuses.length; i++) {
      if (g.statuses[i] === "passed") passed++;
      if (g.statuses[i] === "failed") failed++;
      if (i > 0 && g.statuses[i] !== g.statuses[i - 1]) transitions++;
    }
    if (transitions === 0) continue;
    const flakiness_score = transitions / Math.max(1, total - 1);
    out.push({
      test_suite: g.test_suite,
      name: g.name,
      framework: g.framework,
      total_runs: total,
      passed,
      failed,
      transitions,
      flakiness_score,
      recent_statuses: g.statuses.slice(-FLAKES_RECENT_STATUSES),
    });
  }

  out.sort(
    (a, b) =>
      b.flakiness_score - a.flakiness_score || b.total_runs - a.total_runs,
  );
  return out;
}

// ---------- dashboard KPIs ----------

export type StatusGroup = { value: string; count: number };
export type SuiteGroup = { suite: string; count: number };

/**
 * Derive the dashboard KPIs from aggregate primitives.
 *
 * `caseStatusGroups` is the per-status group counts over the window (passed +
 * failed + skipped); `totalCases` is their sum (matches the old `meta.count`,
 * which spanned all statuses). `passRate = passed / totalCases`.
 */
export function deriveKpis(args: {
  totalRuns: number;
  avgDurationMean: number | null;
  caseStatusGroups: StatusGroup[];
  failedSuiteGroups: SuiteGroup[];
}): DashboardKpis {
  const totalCases = args.caseStatusGroups.reduce((s, g) => s + g.count, 0);
  const passed =
    args.caseStatusGroups.find((g) => g.value === "passed")?.count ?? 0;
  const passRate = totalCases > 0 ? passed / totalCases : 0;
  const top = [...args.failedSuiteGroups].sort((a, b) => b.count - a.count)[0];
  return {
    passRate,
    avgRunDurationMs: Math.round(args.avgDurationMean ?? 0),
    topFailingSuite: top ?? null,
    totalRuns: args.totalRuns,
    totalCases,
  };
}

// ---------- version rollup ----------

export type RunRow = {
  version_minor: string | null;
  version_patch: string | null;
  status: string;
};

/**
 * Roll up TestRun rows per minor version — counting actual rows (NOT Weaviate
 * `Aggregate groupBy`, whose counts are approximate and jitter between
 * refreshes, so the old numerator/denominator ratio was non-deterministic).
 *
 * Pass rate is RUN-level (success runs / total runs): a run with even one
 * failing test is itself failed, which is what a release reviewer wants.
 * Patches are the distinct canonical `version_patch` values, sorted
 * descending. Runs with no `version_minor` are ignored. Minors are sorted
 * descending by string compare.
 */
export function rollupRunsByMinor(rows: RunRow[]): VersionRollup[] {
  type Acc = { runs: number; passingRuns: number; patches: Set<string> };
  const byMinor = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.version_minor) continue;
    let acc = byMinor.get(r.version_minor);
    if (!acc) {
      acc = { runs: 0, passingRuns: 0, patches: new Set() };
      byMinor.set(r.version_minor, acc);
    }
    acc.runs++;
    if (r.status === "success") acc.passingRuns++;
    if (r.version_patch) acc.patches.add(r.version_patch);
  }

  const out: VersionRollup[] = [];
  for (const [minor, acc] of byMinor) {
    out.push({
      minor,
      patches: [...acc.patches].sort().reverse(),
      runs: acc.runs,
      passingRuns: acc.passingRuns,
      passRate: acc.runs > 0 ? acc.passingRuns / acc.runs : null,
    });
  }
  return out.sort((a, b) => (a.minor < b.minor ? 1 : -1));
}
