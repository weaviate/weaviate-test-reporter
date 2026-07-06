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
  version_minor: string | null;
  job_name: string;
  status: TestCaseStatus;
};

/**
 * Group rows by `(test_suite, name, version_minor, job_name)` and compute
 * per-test flakiness within that stable context (WS3 R3). Grouping by version
 * AND job means a test that's DETERMINISTIC for a given version/config — e.g.
 * fails only on 1.36, or only in the `replicas-3` job — is no longer mislabeled
 * flaky by cross-version/cross-job flips. A CI run fans out into many jobs
 * (matrix cells, upgrade/downgrade legs), each a distinct TestCase for the same
 * `{suite, name}`; without the job in the key those all collapse into one group
 * and inflate `total_runs`. Only WITHIN-context flips count.
 *
 * Rows MUST already be ordered by `(test_suite, name, run_started_at)` so each
 * group's status sequence is chronological — a (version, job) subsequence of a
 * time-ordered (suite, name) run inherits that order, so no extra sort is
 * needed. `flakiness_score = transitions / (runs - 1)`. Groups with fewer than
 * `minRuns` observations, or zero transitions (all-passed / all-failed), drop.
 */
export function computeFlaky(rows: FlakeRow[], minRuns = 3): FlakyTest[] {
  type Acc = {
    test_suite: string;
    name: string;
    framework: string;
    version_minor: string | null;
    job_name: string;
    statuses: TestCaseStatus[];
  };
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    const key = `${r.test_suite}${FLAKES_KEY_SEP}${r.name}${FLAKES_KEY_SEP}${r.version_minor ?? ""}${FLAKES_KEY_SEP}${r.job_name}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = {
        test_suite: r.test_suite,
        name: r.name,
        framework: r.framework,
        version_minor: r.version_minor,
        job_name: r.job_name,
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
      version_minor: g.version_minor,
      job_name: g.job_name,
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
 * `totalTests` / `passedTests` / `skippedTests` come from summing the run-level
 * counts (TestRun.tests_*, WS1 D2) over the windowed runs — no full TestCase
 * scan. `passRate` is over EXECUTED tests — `passedTests / (totalTests −
 * skippedTests)` — so intentionally-skipped tests don't drag it down; this
 * matches the /versions definition (#17) and stops the global rate reading far
 * lower than every per-version rate. `totalCases` stays the full count (spans
 * passed + failed + skipped); `skippedCases` is surfaced for transparency.
 */
export function deriveKpis(args: {
  totalRuns: number;
  avgDurationMean: number | null;
  totalTests: number;
  passedTests: number;
  skippedTests: number;
  failedSuiteGroups: SuiteGroup[];
}): DashboardKpis {
  const totalCases = args.totalTests;
  // Exclude skipped from the denominator (clamp ≥ 0 in case a dialect reports
  // skipped > total). Same reasoning as rollupRunsByMinor / #17.
  const executed = Math.max(0, totalCases - args.skippedTests);
  const passRate = executed > 0 ? args.passedTests / executed : 0;
  const top = [...args.failedSuiteGroups].sort((a, b) => b.count - a.count)[0];
  return {
    passRate,
    avgRunDurationMs: Math.round(args.avgDurationMean ?? 0),
    topFailingSuite: top ?? null,
    totalRuns: args.totalRuns,
    totalCases,
    skippedCases: args.skippedTests,
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

// ---------- test-explorer run counts ----------

export type RunCountTone = "muted" | "bad";
export type RunCountSegment = { text: string; tone: RunCountTone };

/**
 * Compact run-level count summary for a Test Explorer row (WS1 D2 counts).
 *
 * Always leads with `passed/total`, then appends `failed` / `errors` / `skipped`
 * segments only when non-zero (errors is usually 0, so it's hidden unless it
 * happened). Returns `[]` when the run carries no counts (`tests_total <= 0` —
 * e.g. a legacy row ingested before WS1), so the caller renders nothing rather
 * than a misleading "0/0". `tests_total` INCLUDES skipped, matching the schema.
 */
export function summarizeRunCounts(c: {
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  tests_skipped: number;
  tests_errors: number;
}): RunCountSegment[] {
  if (!c.tests_total || c.tests_total <= 0) return [];
  const segs: RunCountSegment[] = [
    { text: `${c.tests_passed}/${c.tests_total}`, tone: "muted" },
  ];
  if (c.tests_failed > 0)
    segs.push({ text: `${c.tests_failed} failed`, tone: "bad" });
  if (c.tests_errors > 0)
    segs.push({ text: `${c.tests_errors} errors`, tone: "bad" });
  if (c.tests_skipped > 0)
    segs.push({ text: `${c.tests_skipped} skipped`, tone: "muted" });
  return segs;
}

// ---------- dashboard trend (time series, WS2 H2) ----------

export type TrendRunRow = {
  started_at: string; // UTC ISO (WS1 D1); "" for a legacy row with no run-start
  status: string;
  total_duration_ms: number;
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  tests_skipped: number;
  tests_errors: number;
};

export type TrendPoint = {
  day: string; // "YYYY-MM-DD" (UTC)
  runs: number;
  passingRuns: number;
  tests: number;
  testsPassed: number;
  failures: number; // tests_failed + tests_errors
  testsSkipped: number;
  /** testsPassed / EXECUTED (tests_total − skipped) — over the tests that ran,
   *  matching the dashboard KPI tile and /versions (#17). null when nothing ran. */
  passRate: number | null;
  avgDurationMs: number | null;
};

/**
 * Bucket TestRun rows into a per-UTC-day series for the dashboard trend charts.
 *
 * Pure + deterministic, same house style as `rollupRunsByMinor` (paginate real
 * rows, derive here — not Weaviate's jittery Aggregate groupBy). The day is the
 * UTC calendar date of `started_at` (real run start, WS1 D1), read straight off
 * the ISO string so there's no timezone drift. Rows with no usable `started_at`
 * are skipped rather than bucketed under a bogus day. Output is sorted ascending
 * by day so charts read oldest → newest, left → right.
 */
export function bucketRunsByDay(rows: TrendRunRow[]): TrendPoint[] {
  type Acc = {
    runs: number;
    passingRuns: number;
    tests: number;
    testsPassed: number;
    failures: number;
    testsSkipped: number;
    durationSum: number;
  };
  const byDay = new Map<string, Acc>();
  for (const r of rows) {
    // started_at is a UTC ISO string ("2026-07-01T03:36:42.000Z"); its first 10
    // chars are the UTC calendar day. Skip rows without a usable date.
    if (!r.started_at || r.started_at.length < 10) continue;
    const day = r.started_at.slice(0, 10);
    let acc = byDay.get(day);
    if (!acc) {
      acc = {
        runs: 0,
        passingRuns: 0,
        tests: 0,
        testsPassed: 0,
        failures: 0,
        testsSkipped: 0,
        durationSum: 0,
      };
      byDay.set(day, acc);
    }
    acc.runs++;
    if (r.status === "success") acc.passingRuns++;
    acc.tests += r.tests_total;
    acc.testsPassed += r.tests_passed;
    acc.failures += r.tests_failed + r.tests_errors;
    acc.testsSkipped += r.tests_skipped;
    acc.durationSum += r.total_duration_ms;
  }

  const out: TrendPoint[] = [];
  for (const [day, acc] of byDay) {
    const executed = Math.max(0, acc.tests - acc.testsSkipped);
    out.push({
      day,
      runs: acc.runs,
      passingRuns: acc.passingRuns,
      tests: acc.tests,
      testsPassed: acc.testsPassed,
      failures: acc.failures,
      testsSkipped: acc.testsSkipped,
      // Over executed tests (skipped excluded), matching deriveKpis / #17.
      passRate: executed > 0 ? acc.testsPassed / executed : null,
      avgDurationMs: acc.runs > 0 ? acc.durationSum / acc.runs : null,
    });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Y-axis domain for the pass-rate trend chart. Zooms to the data so small dips
 * are visible instead of a flat line pinned at the top — a healthy suite (99%+)
 * would otherwise hide a drop to 99.5% on a fixed [0,1] axis. Floors to a nice
 * 5% step just BELOW the minimum (never above the data), so the lowest point
 * always sits off the axis floor. Falls back to [0,1] when nothing has a rate.
 */
export function passRateDomain(
  points: { passRate: number | null }[],
): [number, number] {
  const vals = points
    .map((p) => p.passRate)
    .filter((v): v is number => v != null);
  if (vals.length === 0) return [0, 1];
  // Work in integer percent — `Math.floor(1 / 0.05)` is 19, not 20, in float.
  const minPct = Math.min(...vals) * 100;
  const niceMinPct = Math.floor((minPct + 1e-9) / 5) * 5; // nearest 5% ≤ min
  const floorPct = Math.max(0, niceMinPct - 5); // one step of headroom below
  return [floorPct / 100, 1];
}

// ---------- H3: expected-vs-executed (silent test-collapse) ----------

export type ExecutedDropRow = {
  repository: string;
  job_name: string;
  version_minor: string | null; // compare like-for-like versions (see below)
  started_at: string; // UTC ISO; used only to order a job's runs
  tests_total: number;
  tests_skipped: number;
  run_id: string;
  job_url: string;
};

export type ExecutedDrop = {
  repository: string;
  job_name: string;
  versionMinor: string | null;
  prevExecuted: number;
  currExecuted: number;
  prevTotal: number;
  currTotal: number;
  dropPct: number; // 0..1 — share of the previous run's executed tests lost
  currStartedAt: string;
  currRunId: string;
  currJobUrl: string;
};

/** Flag a job whose latest run executed ≥ this fraction fewer tests than the
 *  run before it. Tunable — start conservative to avoid noise. */
export const EXECUTED_DROP_THRESHOLD = 0.1;
/** Ignore trivially small jobs so a 2→1 blip doesn't read as a 50% collapse. */
export const MIN_PREV_EXECUTED = 5;

/**
 * Detect "silent test-collapse" (WS2 H3): jobs whose most recent run ran
 * meaningfully fewer tests than a comparable earlier run — often worse than a
 * red test (a suite quietly stopped collecting / running). Executed =
 * tests_total − tests_skipped (clamped ≥ 0), the same "ran" definition as the
 * pass rate, so a jump in skips counts as a drop too.
 *
 * **Version-aware.** Tests are frequently skipped per version (a feature only
 * exists in 1.37+, so 1.36 runs legitimately execute fewer), so comparing
 * across versions is noise. For each (repository, job_name), the latest run is
 * compared only against the **most recent prior run of the SAME version_minor**.
 * A run on a brand-new version with no same-version predecessor is therefore not
 * evaluated — a version bump can never masquerade as a collapse.
 *
 * Pure + deterministic (house style). A job is flagged when its same-version
 * baseline executed at least MIN_PREV_EXECUTED tests AND the latest run dropped
 * by at least EXECUTED_DROP_THRESHOLD. Rows with no started_at, jobs with fewer
 * than two runs, and latest runs with no same-version baseline are skipped.
 * Output is sorted by drop magnitude, largest first.
 */
export function detectExecutedDrops(rows: ExecutedDropRow[]): ExecutedDrop[] {
  const byJob = new Map<string, ExecutedDropRow[]>();
  for (const r of rows) {
    if (!r.started_at) continue; // can't order it
    const key = `${r.repository}${FLAKES_KEY_SEP}${r.job_name}`;
    const list = byJob.get(key);
    if (list) list.push(r);
    else byJob.set(key, [r]);
  }

  const out: ExecutedDrop[] = [];
  for (const list of byJob.values()) {
    if (list.length < 2) continue;
    // Newest first (ISO strings sort chronologically).
    list.sort((a, b) =>
      a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
    );
    const curr = list[0];
    // Baseline = the most recent OLDER run of the SAME version_minor. Skip over
    // any interleaved runs on a different version so 1.37-vs-1.36 never flags.
    const prev = list
      .slice(1)
      .find((r) => r.version_minor === curr.version_minor);
    if (!prev) continue; // no same-version baseline (e.g. first run on a version)
    const currExecuted = Math.max(0, curr.tests_total - curr.tests_skipped);
    const prevExecuted = Math.max(0, prev.tests_total - prev.tests_skipped);
    if (prevExecuted < MIN_PREV_EXECUTED) continue;
    if (currExecuted > prevExecuted * (1 - EXECUTED_DROP_THRESHOLD)) continue;
    out.push({
      repository: curr.repository,
      job_name: curr.job_name,
      versionMinor: curr.version_minor,
      prevExecuted,
      currExecuted,
      prevTotal: prev.tests_total,
      currTotal: curr.tests_total,
      dropPct: (prevExecuted - currExecuted) / prevExecuted,
      currStartedAt: curr.started_at,
      currRunId: curr.run_id,
      currJobUrl: curr.job_url,
    });
  }
  return out.sort((a, b) => b.dropPct - a.dropPct);
}

// ---------- WS3 R1: single-test history ----------

export type TestHistoryPoint = {
  status: TestCaseStatus; // the test's status in that run
  runStartedAt: string; // UTC ISO of the run (WS1 D1)
  versionMinor: string | null;
  branch: string | null;
  runStatus: string; // the run's overall status
  runId: string;
  jobUrl: string; // deep-link to the CI job
  errorMessage: string | null;
  failureType: string | null;
  durationMs: number;
};

export type TestHistory = {
  testSuite: string;
  name: string;
  framework: string;
  totalRuns: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Transition density over the passed/failed subsequence — same signal as the
   *  Flakes page, scoped to this one test. 0 when it never flipped or ran <2×. */
  flakinessScore: number;
  points: TestHistoryPoint[]; // chronological, oldest → newest
};

/**
 * Shape one test's raw occurrences into its history (WS3 R1). Pure + testable:
 * sorts the points chronologically by run start (UTC ISO sorts correctly),
 * tallies pass/fail/skip, and computes a per-test flakiness score from the
 * pass↔fail transition density (skipped runs carry no signal and are ignored,
 * exactly as the Flakes page does).
 */
export function buildTestHistory(
  meta: { testSuite: string; name: string; framework: string },
  points: TestHistoryPoint[],
): TestHistory {
  const sorted = [...points].sort((a, b) =>
    a.runStartedAt < b.runStartedAt
      ? -1
      : a.runStartedAt > b.runStartedAt
        ? 1
        : 0,
  );

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let transitions = 0;
  let pf = 0; // count of passed/failed observations
  let prev: TestCaseStatus | null = null;
  for (const pt of sorted) {
    if (pt.status === "passed") passed++;
    else if (pt.status === "failed") failed++;
    else skipped++;
    if (pt.status === "passed" || pt.status === "failed") {
      pf++;
      if (prev !== null && pt.status !== prev) transitions++;
      prev = pt.status;
    }
  }

  return {
    testSuite: meta.testSuite,
    name: meta.name,
    framework: meta.framework,
    totalRuns: sorted.length,
    passed,
    failed,
    skipped,
    flakinessScore: pf > 1 ? transitions / (pf - 1) : 0,
    points: sorted,
  };
}
