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

export type FlakeRow = {
  test_suite: string;
  name: string;
  framework: string;
  version_minor: string | null;
  job_name: string;
  status: TestCaseStatus;
};

/** Collision-free composite key for a test in its stable context
 *  `(suite, name, version_minor, job_name)`. JSON-encoded because `job_name` is
 *  workflow input and could contain any delimiter. Shared by `computeFlaky` and
 *  `detectRegressions` so their groupings match exactly. */
export function flakeGroupKey(
  test_suite: string,
  name: string,
  version_minor: string | null,
  job_name: string,
): string {
  return JSON.stringify([test_suite, name, version_minor ?? "", job_name]);
}

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
 * Rows MUST already be ordered so each group's status subsequence is in
 * run_started_at order — the caller sorts by `(test_suite, name,
 * run_started_at)`: the leading keys keep offset pagination stable (every case
 * in a run shares run_started_at, so a single-key sort would tie-collide and
 * skip/dupe rows), and the trailing time key makes each group chronological.
 * Grouping is by Map, so array contiguity isn't required. `flakiness_score =
 * transitions / (runs - 1)`. Groups with < `minRuns` obs, or 0 transitions, drop.
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
    const key = flakeGroupKey(
      r.test_suite,
      r.name,
      r.version_minor,
      r.job_name,
    );
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

// ---------- regressions: NEW vs known (R2) ----------

/** A failing TestCase in the current window (denormalized fields). */
export type RegressionRow = {
  test_suite: string;
  name: string;
  version_minor: string | null;
  job_name: string;
  run_started_at: string; // UTC ISO
  error_message: string | null;
  failure_type: string | null;
};

/** A NEW regression: a `(suite, name, version, job)` failing in the current
 *  window that did NOT fail in the prior window and is not a known flake. */
export type NewRegression = {
  test_suite: string;
  name: string;
  version_minor: string | null;
  job_name: string;
  failCount: number; // failures in the current window
  firstFailedAt: string; // earliest failure in the current window (UTC ISO)
  lastErrorMessage: string | null; // from the most recent failure
  lastFailureType: string | null;
};

export type RegressionReport = {
  regressions: NewRegression[]; // the NEW ones, most failures first
  newCount: number;
  knownFlakyCount: number; // failing now but a known flake (suppressed)
  recurringCount: number; // failing now + failed in the prior window (not flaky)
};

/**
 * Classify the current window's failures into NEW regressions vs already-known
 * noise (WS3 R2). A failing `(suite, name, version_minor, job_name)` group is:
 *   - **known-flaky** if its key is in `flakyKeys` (the R3 transition-density
 *     list) — suppressed, even if it didn't fail in the prior window;
 *   - **recurring** else if its key is in `priorFailedKeys` (it failed before,
 *     so it's not a fresh regression);
 *   - **NEW** otherwise — failing now, no prior failure, not flaky ⇒ the
 *     actionable regression.
 * Precedence is flaky → recurring → NEW, so every group lands in exactly one
 * bucket. Pure + window-agnostic: the caller windows the inputs. Keys are built
 * with `flakeGroupKey`, matching `computeFlaky` exactly.
 */
export function detectRegressions(
  currentFailed: RegressionRow[],
  priorFailedKeys: Set<string>,
  flakyKeys: Set<string>,
): RegressionReport {
  type Acc = {
    row: RegressionRow; // representative (identity fields)
    failCount: number;
    firstFailedAt: string;
    lastAt: string;
    lastErrorMessage: string | null;
    lastFailureType: string | null;
  };
  const groups = new Map<string, Acc>();
  for (const r of currentFailed) {
    const key = flakeGroupKey(
      r.test_suite,
      r.name,
      r.version_minor,
      r.job_name,
    );
    const acc = groups.get(key);
    if (!acc) {
      groups.set(key, {
        row: r,
        failCount: 1,
        firstFailedAt: r.run_started_at,
        lastAt: r.run_started_at,
        lastErrorMessage: r.error_message,
        lastFailureType: r.failure_type,
      });
    } else {
      acc.failCount++;
      if (r.run_started_at < acc.firstFailedAt)
        acc.firstFailedAt = r.run_started_at;
      // Keep the most-recent failure's error for display.
      if (r.run_started_at >= acc.lastAt) {
        acc.lastAt = r.run_started_at;
        acc.lastErrorMessage = r.error_message;
        acc.lastFailureType = r.failure_type;
      }
    }
  }

  const regressions: NewRegression[] = [];
  let knownFlakyCount = 0;
  let recurringCount = 0;
  for (const [key, g] of groups) {
    if (flakyKeys.has(key)) {
      knownFlakyCount++;
    } else if (priorFailedKeys.has(key)) {
      recurringCount++;
    } else {
      regressions.push({
        test_suite: g.row.test_suite,
        name: g.row.name,
        version_minor: g.row.version_minor,
        job_name: g.row.job_name,
        failCount: g.failCount,
        firstFailedAt: g.firstFailedAt,
        lastErrorMessage: g.lastErrorMessage,
        lastFailureType: g.lastFailureType,
      });
    }
  }

  // Most failures first; ties broken by earliest onset (older regressions
  // first — they've been broken longer), then the full identity key for a
  // TOTAL order (unique per NEW regression, so no insertion-order dependence).
  regressions.sort((a, b) => {
    if (b.failCount !== a.failCount) return b.failCount - a.failCount;
    if (a.firstFailedAt !== b.firstFailedAt)
      return a.firstFailedAt < b.firstFailedAt ? -1 : 1;
    const ka = flakeGroupKey(a.test_suite, a.name, a.version_minor, a.job_name);
    const kb = flakeGroupKey(b.test_suite, b.name, b.version_minor, b.job_name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    regressions,
    newCount: regressions.length,
    knownFlakyCount,
    recurringCount,
  };
}

// ---------- failure clustering by fingerprint (R4) ----------

/** A failing TestCase for clustering (D4 fingerprint + identity + context). */
export type ClusterRow = {
  failure_fingerprint: string | null;
  test_suite: string;
  name: string;
  error_message: string | null;
  failure_type: string | null;
  run_started_at: string; // UTC ISO
};

/** A cluster of identical failures sharing one D4 `failure_fingerprint`. */
export type FailureCluster = {
  fingerprint: string;
  occurrences: number; // total failures with this fingerprint
  affectedTests: number; // distinct (suite, name)
  affectedSuites: number; // distinct suite
  sampleError: string | null; // representative error (most recent occurrence)
  sampleFailureType: string | null;
  firstSeen: string; // UTC ISO
  lastSeen: string; // UTC ISO
};

export type ClusterReport = {
  clusters: FailureCluster[]; // ranked by affectedTests desc, then occurrences
  uncategorized: number; // failures with no fingerprint (can't be clustered)
  totalFailures: number; // all failures scanned in the window
};

/**
 * Group failures by their D4 `failure_fingerprint` (exact hash of the
 * normalized trace) to collapse mass-failure noise (WS3 R4): a shared root
 * cause failing many tests ("DB reset ×47") becomes ONE cluster. Only
 * fingerprints hitting at least `minTests` DISTINCT tests are surfaced — a
 * single test failing repeatedly isn't mass-failure (it's flakes/regression
 * territory). Failures with no fingerprint (null/empty — e.g. no stack trace)
 * are counted as `uncategorized`, not clustered. Exact-hash only — no fuzzy /
 * vector similarity (that would duplicate Semantic Search). Pure + window-
 * agnostic; the caller windows the input.
 */
export function clusterFailures(
  rows: ClusterRow[],
  minTests = 2,
): ClusterReport {
  type Acc = {
    fingerprint: string;
    occurrences: number;
    tests: Set<string>; // distinct (suite, name)
    suites: Set<string>;
    lastAt: string;
    sampleError: string | null;
    sampleFailureType: string | null;
    firstSeen: string;
    lastSeen: string;
  };
  const groups = new Map<string, Acc>();
  let uncategorized = 0;

  for (const r of rows) {
    const fp = r.failure_fingerprint;
    if (!fp) {
      uncategorized++;
      continue;
    }
    let acc = groups.get(fp);
    if (!acc) {
      acc = {
        fingerprint: fp,
        occurrences: 0,
        tests: new Set(),
        suites: new Set(),
        lastAt: r.run_started_at,
        sampleError: r.error_message,
        sampleFailureType: r.failure_type,
        firstSeen: r.run_started_at,
        lastSeen: r.run_started_at,
      };
      groups.set(fp, acc);
    }
    acc.occurrences++;
    // JSON-encoded (suite, name): collision-free and no control byte in source.
    acc.tests.add(JSON.stringify([r.test_suite, r.name]));
    acc.suites.add(r.test_suite);
    if (r.run_started_at < acc.firstSeen) acc.firstSeen = r.run_started_at;
    if (r.run_started_at >= acc.lastAt) {
      // Keep the most-recent occurrence's error as the representative.
      acc.lastAt = r.run_started_at;
      acc.lastSeen = r.run_started_at;
      acc.sampleError = r.error_message;
      acc.sampleFailureType = r.failure_type;
    }
  }

  const clusters: FailureCluster[] = [];
  for (const g of groups.values()) {
    if (g.tests.size < minTests) continue; // not mass-failure — skip singletons
    clusters.push({
      fingerprint: g.fingerprint,
      occurrences: g.occurrences,
      affectedTests: g.tests.size,
      affectedSuites: g.suites.size,
      sampleError: g.sampleError,
      sampleFailureType: g.sampleFailureType,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
    });
  }

  // Biggest blast radius first (distinct tests), then total occurrences, then
  // fingerprint for a total, stable order.
  clusters.sort(
    (a, b) =>
      b.affectedTests - a.affectedTests ||
      b.occurrences - a.occurrences ||
      (a.fingerprint < b.fingerprint
        ? -1
        : a.fingerprint > b.fingerprint
          ? 1
          : 0),
  );

  return { clusters, uncategorized, totalFailures: rows.length };
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
  // The baseline run this was compared against (the previous run of the same
  // (repo, job, version) leg) — so the UI can show both sides of the drop.
  prevStartedAt: string;
  prevRunId: string;
  prevJobUrl: string;
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
 * **Version-aware — per version leg.** Tests are frequently skipped per version
 * (a feature only exists in 1.37+, so 1.36 runs legitimately execute fewer), so
 * comparing across versions is noise. We group by
 * `(repository, job_name, version_minor)` and evaluate the latest-vs-previous
 * run **within each group**, so every version leg of a job is checked — not just
 * the job's single overall-newest run. This matters because one job fans out
 * across versions per weekly batch (e.g. the 1.37 leg starting minutes after the
 * 1.36 leg): grouping only by (repo, job) and inspecting the newest run would
 * silently miss a collapse on any version that isn't the overall-newest. A run
 * on a brand-new version with no same-version predecessor still isn't evaluated —
 * a version bump can never masquerade as a collapse.
 *
 * Pure + deterministic (house style). A leg is flagged when its previous
 * same-version run executed at least MIN_PREV_EXECUTED tests AND the latest run
 * dropped by at least EXECUTED_DROP_THRESHOLD. Rows with no started_at and legs
 * with fewer than two runs are skipped. A single job can therefore surface more
 * than one drop (one per collapsing version). Output is sorted by drop
 * magnitude, largest first.
 */
export function detectExecutedDrops(rows: ExecutedDropRow[]): ExecutedDrop[] {
  const byLeg = new Map<string, ExecutedDropRow[]>();
  for (const r of rows) {
    if (!r.started_at) continue; // can't order it
    const key = JSON.stringify([
      r.repository,
      r.job_name,
      r.version_minor ?? "",
    ]);
    const list = byLeg.get(key);
    if (list) list.push(r);
    else byLeg.set(key, [r]);
  }

  const out: ExecutedDrop[] = [];
  for (const list of byLeg.values()) {
    if (list.length < 2) continue;
    // Newest first (ISO strings sort chronologically).
    list.sort((a, b) =>
      a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
    );
    const curr = list[0];
    // Baseline = the previous run of this same (repo, job, version) leg.
    const prev = list[1];
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
      prevStartedAt: prev.started_at,
      prevRunId: prev.run_id,
      prevJobUrl: prev.job_url,
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
  jobName: string; // the CI job (matrix cell / upgrade leg) this ran in
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

export type JobHistory = { job: string; points: TestHistoryPoint[] };

/**
 * Split a test's history into one series per CI job (WS3 R3). A test runs once
 * per job per run (matrix cells / upgrade legs), so a single interleaved
 * timeline mixes configs; per-job series read as coherent run-over-run
 * sequences. Points are assumed already chronological (as `buildTestHistory`
 * returns them) and keep that order within each series; series are ordered by
 * most-recent activity first.
 */
export function groupHistoryByJob(points: TestHistoryPoint[]): JobHistory[] {
  const byJob = new Map<string, TestHistoryPoint[]>();
  for (const p of points) {
    const key = p.jobName || "";
    const list = byJob.get(key);
    if (list) list.push(p);
    else byJob.set(key, [p]);
  }
  const series = [...byJob.entries()].map(([job, pts]) => ({
    job,
    points: pts,
  }));
  series.sort((a, b) => {
    const la = a.points[a.points.length - 1]?.runStartedAt ?? "";
    const lb = b.points[b.points.length - 1]?.runStartedAt ?? "";
    return la < lb ? 1 : la > lb ? -1 : 0;
  });
  return series;
}
