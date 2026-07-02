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
 * `totalTests` / `passedTests` come from summing the run-level counts
 * (TestRun.tests_total / tests_passed, WS1 D2) over the windowed runs — no full
 * TestCase scan. `totalCases = totalTests` (spans passed + failed + skipped,
 * matching the old meta.count); `passRate = passedTests / totalTests`.
 */
export function deriveKpis(args: {
  totalRuns: number;
  avgDurationMean: number | null;
  totalTests: number;
  passedTests: number;
  failedSuiteGroups: SuiteGroup[];
}): DashboardKpis {
  const totalCases = args.totalTests;
  const passRate = totalCases > 0 ? args.passedTests / totalCases : 0;
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
  tests_total: number;
  tests_passed: number;
  tests_skipped: number;
};

/**
 * Roll up TestRun rows per minor version — counting actual rows (NOT Weaviate
 * `Aggregate groupBy`, whose counts are approximate and jitter between
 * refreshes, so the old numerator/denominator ratio was non-deterministic).
 *
 * Two pass rates are surfaced. RUN-level (success runs / total runs) — a run
 * with even one failing test is itself failed, which is what a release
 * reviewer wants. TEST-level (Σ tests_passed / Σ EXECUTED, where executed =
 * total − skipped) — the share of the tests that actually RAN that passed.
 * Skipped tests are excluded from BOTH sides so intentionally-skipped tests
 * (feature flags / platform gating) don't read as failures and drag the rate
 * down. Both come straight off the run-level counts (TestRun.tests_*, WS1 D2)
 * — no TestCase scan. Patches are the distinct canonical `version_patch`
 * values, sorted descending. Runs with no `version_minor` are ignored. Minors
 * are sorted descending by string compare.
 */
export function rollupRunsByMinor(rows: RunRow[]): VersionRollup[] {
  type Acc = {
    runs: number;
    passingRuns: number;
    tests: number;
    testsPassed: number;
    testsSkipped: number;
    patches: Set<string>;
  };
  const byMinor = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.version_minor) continue;
    let acc = byMinor.get(r.version_minor);
    if (!acc) {
      acc = {
        runs: 0,
        passingRuns: 0,
        tests: 0,
        testsPassed: 0,
        testsSkipped: 0,
        patches: new Set(),
      };
      byMinor.set(r.version_minor, acc);
    }
    acc.runs++;
    if (r.status === "success") acc.passingRuns++;
    acc.tests += r.tests_total;
    acc.testsPassed += r.tests_passed;
    acc.testsSkipped += r.tests_skipped;
    if (r.version_patch) acc.patches.add(r.version_patch);
  }

  const out: VersionRollup[] = [];
  for (const [minor, acc] of byMinor) {
    // Rate over EXECUTED tests — skipped excluded from both sides so
    // intentionally-skipped tests don't look like failures. Clamp to >= 0 in
    // case a dialect ever reports tests_skipped > tests_total (some JUnit
    // writers count `tests` as executed-only).
    const executed = Math.max(0, acc.tests - acc.testsSkipped);
    out.push({
      minor,
      patches: [...acc.patches].sort().reverse(),
      runs: acc.runs,
      passingRuns: acc.passingRuns,
      passRate: acc.runs > 0 ? acc.passingRuns / acc.runs : null,
      tests: acc.tests,
      testsPassed: acc.testsPassed,
      testsSkipped: acc.testsSkipped,
      testPassRate: executed > 0 ? acc.testsPassed / executed : null,
    });
  }
  return out.sort((a, b) => (a.minor < b.minor ? 1 : -1));
}
