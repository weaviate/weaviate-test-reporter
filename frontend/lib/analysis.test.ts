import { describe, it, expect } from "vitest";
import {
  isoDaysAgo,
  computeFlaky,
  deriveKpis,
  rollupRunsByMinor,
  summarizeRunCounts,
  bucketRunsByDay,
  passRateDomain,
  detectExecutedDrops,
  buildTestHistory,
  FLAKES_RECENT_STATUSES,
  type FlakeRow,
  type TrendRunRow,
  type ExecutedDropRow,
  type TestHistoryPoint,
} from "./analysis";
import type { TestCaseStatus } from "./types";

const row = (
  test_suite: string,
  name: string,
  status: TestCaseStatus,
  framework = "pytest",
  version_minor: string | null = "1.37",
  job_name = "job-a",
): FlakeRow => ({
  test_suite,
  name,
  status,
  framework,
  version_minor,
  job_name,
});

describe("isoDaysAgo", () => {
  it("returns a UTC-midnight ISO string", () => {
    expect(isoDaysAgo(0)).toMatch(/T00:00:00\.000Z$/);
  });
  it("goes further back as days increases", () => {
    expect(isoDaysAgo(7) < isoDaysAgo(0)).toBe(true);
    expect(isoDaysAgo(30) < isoDaysAgo(7)).toBe(true);
  });
});

describe("computeFlaky", () => {
  it("scores a fully-alternating test as maximally flaky", () => {
    const rows = [
      row("a", "x", "passed"),
      row("a", "x", "failed"),
      row("a", "x", "passed"),
      row("a", "x", "failed"),
    ];
    const [t] = computeFlaky(rows);
    expect(t).toMatchObject({
      test_suite: "a",
      name: "x",
      total_runs: 4,
      passed: 2,
      failed: 2,
      transitions: 3,
      flakiness_score: 1,
    });
    expect(t.recent_statuses).toEqual(["passed", "failed", "passed", "failed"]);
  });

  it("drops stable (all-passed / all-failed) tests", () => {
    const rows = [
      row("a", "stable", "passed"),
      row("a", "stable", "passed"),
      row("a", "stable", "passed"),
    ];
    expect(computeFlaky(rows)).toEqual([]);
  });

  it("drops tests below the minRuns threshold", () => {
    const rows = [row("a", "x", "passed"), row("a", "x", "failed")];
    expect(computeFlaky(rows, 3)).toEqual([]);
  });

  it("groups by (suite, name) — same name in different suites is distinct", () => {
    const rows = [
      row("suiteA", "dup", "passed"),
      row("suiteA", "dup", "failed"),
      row("suiteA", "dup", "passed"),
      row("suiteB", "dup", "failed"),
      row("suiteB", "dup", "passed"),
      row("suiteB", "dup", "failed"),
    ];
    const out = computeFlaky(rows);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((t) => t.test_suite))).toEqual(
      new Set(["suiteA", "suiteB"]),
    );
  });

  it("caps recent_statuses at the configured window", () => {
    const statuses: TestCaseStatus[] = [];
    for (let i = 0; i < 40; i++)
      statuses.push(i % 2 === 0 ? "passed" : "failed");
    const rows = statuses.map((s) => row("a", "x", s));
    const [t] = computeFlaky(rows);
    expect(t.recent_statuses).toHaveLength(FLAKES_RECENT_STATUSES);
    expect(t.total_runs).toBe(40);
  });

  it("sorts flakiest first, ties broken by total_runs", () => {
    const rows = [
      // score 1.0 over 3 runs
      row("a", "low", "passed"),
      row("a", "low", "failed"),
      row("a", "low", "passed"),
      // score 1.0 over 5 runs (more observations → ranks higher on tie)
      row("b", "high", "passed"),
      row("b", "high", "failed"),
      row("b", "high", "passed"),
      row("b", "high", "failed"),
      row("b", "high", "passed"),
    ];
    const out = computeFlaky(rows);
    expect(out.map((t) => t.name)).toEqual(["high", "low"]);
  });

  it("does NOT flag a version-deterministic test (fails only on one version)", () => {
    // Interleaved across versions by time, but stable WITHIN each version:
    // passes on 1.37, fails on 1.36. Grouped globally this looks maximally
    // flaky (pass,fail,pass,fail,…); grouped per version it's stable → dropped.
    const rows = [
      row("s", "x", "passed", "pytest", "1.37"),
      row("s", "x", "failed", "pytest", "1.36"),
      row("s", "x", "passed", "pytest", "1.37"),
      row("s", "x", "failed", "pytest", "1.36"),
      row("s", "x", "passed", "pytest", "1.37"),
      row("s", "x", "failed", "pytest", "1.36"),
    ];
    expect(computeFlaky(rows)).toEqual([]);
  });

  it("scores flakiness per version and labels the row with its version", () => {
    const rows = [
      // flaky on 1.37 (pass,fail,pass), stable on 1.36 (pass,pass,pass)
      row("s", "y", "passed", "pytest", "1.37"),
      row("s", "y", "failed", "pytest", "1.37"),
      row("s", "y", "passed", "pytest", "1.37"),
      row("s", "y", "passed", "pytest", "1.36"),
      row("s", "y", "passed", "pytest", "1.36"),
      row("s", "y", "passed", "pytest", "1.36"),
    ];
    const out = computeFlaky(rows);
    expect(out).toHaveLength(1); // only the 1.37 group flaked
    expect(out[0]).toMatchObject({
      name: "y",
      version_minor: "1.37",
      transitions: 2,
    });
  });

  it("does NOT flag a test that's deterministic per job (fails only in one job)", () => {
    // Same test, same version, two jobs (e.g. matrix cells): passes in job-a,
    // fails in job-b. Interleaved by time it looks flaky; per-job it's stable.
    const rows = [
      row("s", "x", "passed", "pytest", "1.37", "job-a"),
      row("s", "x", "failed", "pytest", "1.37", "job-b"),
      row("s", "x", "passed", "pytest", "1.37", "job-a"),
      row("s", "x", "failed", "pytest", "1.37", "job-b"),
      row("s", "x", "passed", "pytest", "1.37", "job-a"),
      row("s", "x", "failed", "pytest", "1.37", "job-b"),
    ];
    expect(computeFlaky(rows)).toEqual([]);
  });

  it("scopes flakiness to a job and labels the row with it", () => {
    const rows = [
      row("s", "y", "passed", "pytest", "1.37", "job-a"),
      row("s", "y", "failed", "pytest", "1.37", "job-a"),
      row("s", "y", "passed", "pytest", "1.37", "job-a"),
      row("s", "y", "passed", "pytest", "1.37", "job-b"),
      row("s", "y", "passed", "pytest", "1.37", "job-b"),
      row("s", "y", "passed", "pytest", "1.37", "job-b"),
    ];
    const out = computeFlaky(rows);
    expect(out).toHaveLength(1); // only job-a flaked
    expect(out[0]).toMatchObject({
      name: "y",
      version_minor: "1.37",
      job_name: "job-a",
    });
  });
});

describe("deriveKpis", () => {
  it("computes pass rate over executed tests, plus avg duration + top failing suite", () => {
    const kpis = deriveKpis({
      totalRuns: 3,
      avgDurationMean: 1234.5,
      totalTests: 10,
      passedTests: 8,
      skippedTests: 0,
      failedSuiteGroups: [
        { suite: "suiteA", count: 2 },
        { suite: "suiteB", count: 5 },
      ],
    });
    expect(kpis).toEqual({
      passRate: 0.8,
      avgRunDurationMs: 1235,
      topFailingSuite: { suite: "suiteB", count: 5 },
      totalRuns: 3,
      totalCases: 10,
      skippedCases: 0,
    });
  });

  it("excludes skipped from the pass-rate denominator (of the tests that ran)", () => {
    const kpis = deriveKpis({
      totalRuns: 1,
      avgDurationMean: null,
      totalTests: 10, // 6 passed + 2 failed + 2 skipped
      passedTests: 6,
      skippedTests: 2,
      failedSuiteGroups: [],
    });
    expect(kpis.totalCases).toBe(10); // full count still reported
    expect(kpis.skippedCases).toBe(2);
    // 6 passed of 8 EXECUTED (10 − 2 skipped) = 0.75 — NOT 6/10 = 0.6.
    expect(kpis.passRate).toBe(0.75);
    expect(kpis.topFailingSuite).toBeNull();
    expect(kpis.avgRunDurationMs).toBe(0);
  });

  it("guards against divide-by-zero when nothing ran", () => {
    const kpis = deriveKpis({
      totalRuns: 0,
      avgDurationMean: null,
      totalTests: 0,
      passedTests: 0,
      skippedTests: 0,
      failedSuiteGroups: [],
    });
    expect(kpis.passRate).toBe(0);
    expect(kpis.totalCases).toBe(0);
  });
});

describe("rollupRunsByMinor", () => {
  it("counts rows exactly, derives run + test pass rates (skipped excluded), sorted distinct patches, newest minor first", () => {
    const out = rollupRunsByMinor([
      {
        version_minor: "1.37",
        version_patch: "1.37.0",
        status: "success",
        tests_total: 25,
        tests_passed: 20,
        tests_skipped: 5,
      },
      {
        version_minor: "1.37",
        version_patch: "1.37.1",
        status: "success",
        tests_total: 25,
        tests_passed: 20,
        tests_skipped: 5,
      },
      {
        version_minor: "1.37",
        version_patch: "1.37.0",
        status: "success",
        tests_total: 25,
        tests_passed: 20,
        tests_skipped: 5,
      },
      {
        version_minor: "1.37",
        version_patch: "1.37.1",
        status: "failure",
        tests_total: 25,
        tests_passed: 12,
        tests_skipped: 5,
      },
      {
        version_minor: "1.38",
        version_patch: "1.38.0",
        status: "success",
        tests_total: 5,
        tests_passed: 5,
        tests_skipped: 0,
      },
      {
        version_minor: "1.38",
        version_patch: "1.38.0",
        status: "success",
        tests_total: 5,
        tests_passed: 5,
        tests_skipped: 0,
      },
    ]);
    expect(out.map((r) => r.minor)).toEqual(["1.38", "1.37"]);
    const v137 = out.find((r) => r.minor === "1.37")!;
    expect(v137.runs).toBe(4);
    expect(v137.passingRuns).toBe(3);
    expect(v137.passRate).toBe(0.75);
    expect(v137.tests).toBe(100);
    expect(v137.testsPassed).toBe(72);
    expect(v137.testsSkipped).toBe(20);
    // 72 passed of 80 EXECUTED (100 − 20 skipped) = 0.9 — NOT 72/100 = 0.72.
    expect(v137.testPassRate).toBe(0.9);
    // distinct (1.37.0 appears twice), sorted descending
    expect(v137.patches).toEqual(["1.37.1", "1.37.0"]);
  });

  it("excludes skipped from the test pass rate; ignores null minors; dedupes patches", () => {
    const out = rollupRunsByMinor([
      {
        version_minor: null,
        version_patch: "x",
        status: "success",
        tests_total: 3,
        tests_passed: 3,
        tests_skipped: 0,
      },
      {
        version_minor: "1.40",
        version_patch: "1.40.0",
        status: "failure",
        tests_total: 10,
        tests_passed: 6,
        tests_skipped: 2,
      },
      {
        version_minor: "1.40",
        version_patch: "1.40.0",
        status: "failure",
        tests_total: 10,
        tests_passed: 6,
        tests_skipped: 2,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      minor: "1.40",
      runs: 2,
      passingRuns: 0,
      passRate: 0,
      tests: 20,
      testsPassed: 12,
      testsSkipped: 4,
      // 12 passed of 16 executed (20 − 4 skipped) = 0.75 (not 12/20 = 0.6).
      testPassRate: 0.75,
      patches: ["1.40.0"],
    });
  });

  it("returns null test pass rate when everything was skipped (nothing executed)", () => {
    const out = rollupRunsByMinor([
      {
        version_minor: "1.41",
        version_patch: "1.41.0",
        status: "success",
        tests_total: 8,
        tests_passed: 0,
        tests_skipped: 8,
      },
    ]);
    expect(out[0].tests).toBe(8);
    expect(out[0].testsSkipped).toBe(8);
    expect(out[0].testPassRate).toBeNull();
  });

  it("clamps executed to >= 0 when a dialect reports tests_skipped > tests_total", () => {
    const out = rollupRunsByMinor([
      {
        version_minor: "1.42",
        version_patch: "1.42.0",
        status: "success",
        tests_total: 5,
        tests_passed: 5,
        tests_skipped: 8,
      },
    ]);
    // executed = max(0, 5 − 8) = 0 → null, never a negative rate.
    expect(out[0].testPassRate).toBeNull();
  });
});

describe("summarizeRunCounts", () => {
  it("leads with passed/total and appends only the non-zero failed/skipped segments", () => {
    const segs = summarizeRunCounts({
      tests_total: 167,
      tests_passed: 154,
      tests_failed: 3,
      tests_skipped: 10,
      tests_errors: 0,
    });
    expect(segs).toEqual([
      { text: "154/167", tone: "muted" },
      { text: "3 failed", tone: "bad" },
      { text: "10 skipped", tone: "muted" },
    ]);
  });

  it("shows only the ratio when everything passed", () => {
    const segs = summarizeRunCounts({
      tests_total: 100,
      tests_passed: 100,
      tests_failed: 0,
      tests_skipped: 0,
      tests_errors: 0,
    });
    expect(segs).toEqual([{ text: "100/100", tone: "muted" }]);
  });

  it("surfaces errors as a distinct segment when present", () => {
    const segs = summarizeRunCounts({
      tests_total: 50,
      tests_passed: 45,
      tests_failed: 2,
      tests_skipped: 1,
      tests_errors: 2,
    });
    expect(segs).toEqual([
      { text: "45/50", tone: "muted" },
      { text: "2 failed", tone: "bad" },
      { text: "2 errors", tone: "bad" },
      { text: "1 skipped", tone: "muted" },
    ]);
  });

  it("returns [] for a legacy row with no counts (tests_total 0) so nothing renders", () => {
    expect(
      summarizeRunCounts({
        tests_total: 0,
        tests_passed: 0,
        tests_failed: 0,
        tests_skipped: 0,
        tests_errors: 0,
      }),
    ).toEqual([]);
  });
});

describe("bucketRunsByDay", () => {
  const trendRow = (
    started_at: string,
    status: string,
    over: Partial<TrendRunRow> = {},
  ): TrendRunRow => ({
    started_at,
    status,
    total_duration_ms: 0,
    tests_total: 0,
    tests_passed: 0,
    tests_failed: 0,
    tests_skipped: 0,
    tests_errors: 0,
    ...over,
  });

  it("buckets by UTC day, sums counts, derives passRate + avgDuration, sorted oldest→newest", () => {
    const out = bucketRunsByDay([
      trendRow("2026-07-01T03:00:00.000Z", "success", {
        total_duration_ms: 100_000,
        tests_total: 100,
        tests_passed: 90,
        tests_failed: 0,
        tests_skipped: 10,
      }),
      trendRow("2026-07-01T09:00:00.000Z", "failure", {
        total_duration_ms: 200_000,
        tests_total: 100,
        tests_passed: 72,
        tests_failed: 18,
        tests_skipped: 10,
      }),
      trendRow("2026-07-02T10:00:00.000Z", "success", {
        total_duration_ms: 50_000,
        tests_total: 50,
        tests_passed: 50,
      }),
      trendRow("2026-06-30T22:00:00.000Z", "success", {
        total_duration_ms: 70_000,
        tests_total: 60,
        tests_passed: 54,
        tests_failed: 5,
        tests_errors: 1,
      }),
    ]);

    expect(out.map((p) => p.day)).toEqual([
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
    ]);

    const d0701 = out.find((p) => p.day === "2026-07-01")!;
    expect(d0701).toMatchObject({
      runs: 2,
      passingRuns: 1, // only the "success" run
      tests: 200,
      testsPassed: 162,
      failures: 18, // 0 + 18 failed, 0 errors
      testsSkipped: 20,
      passRate: 0.9, // 162 / 180 EXECUTED (200 − 20 skipped) — NOT 162/200 = 0.81
      avgDurationMs: 150_000, // (100k + 200k) / 2
    });

    // errors fold into the failures count (5 failed + 1 error = 6)
    expect(out.find((p) => p.day === "2026-06-30")!.failures).toBe(6);
  });

  it("skips rows with no usable started_at rather than bucketing a bogus day", () => {
    const out = bucketRunsByDay([
      trendRow("", "success", { tests_total: 10, tests_passed: 10 }),
      trendRow("2026-07-01T00:00:00.000Z", "success", {
        tests_total: 10,
        tests_passed: 10,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].day).toBe("2026-07-01");
    expect(out[0].runs).toBe(1);
  });

  it("returns null passRate for a day whose runs recorded no tests", () => {
    const out = bucketRunsByDay([
      trendRow("2026-07-01T00:00:00.000Z", "failure", {
        total_duration_ms: 5_000,
      }),
    ]);
    expect(out[0].passRate).toBeNull();
    expect(out[0].avgDurationMs).toBe(5_000);
    expect(out[0].runs).toBe(1);
  });

  it("returns [] for no rows", () => {
    expect(bucketRunsByDay([])).toEqual([]);
  });
});

describe("passRateDomain", () => {
  it("zooms in when the suite is healthy so small dips are visible", () => {
    // min 0.995 → nice floor 0.95 → one step of headroom → 0.90
    expect(passRateDomain([{ passRate: 0.998 }, { passRate: 0.995 }])).toEqual([
      0.9, 1,
    ]);
  });

  it("drops the floor when there are real failures", () => {
    expect(passRateDomain([{ passRate: 0.6 }, { passRate: 0.99 }])).toEqual([
      0.55, 1,
    ]);
  });

  it("keeps headroom below a perfect 100% so a future dip would show", () => {
    expect(passRateDomain([{ passRate: 1 }])).toEqual([0.95, 1]);
  });

  it("falls back to [0,1] when no point has a rate", () => {
    expect(passRateDomain([{ passRate: null }])).toEqual([0, 1]);
  });
});

describe("detectExecutedDrops", () => {
  const dropRow = (
    repository: string,
    job_name: string,
    started_at: string,
    tests_total: number,
    tests_skipped = 0,
    version_minor: string | null = "1.37",
  ): ExecutedDropRow => ({
    repository,
    job_name,
    version_minor,
    started_at,
    tests_total,
    tests_skipped,
    run_id: `${job_name}-${started_at}`,
    job_url: "https://ci/x",
  });

  it("flags a job whose latest run executed ≥10% fewer tests than the run before", () => {
    const out = detectExecutedDrops([
      dropRow("weaviate", "e2e", "2026-07-05T10:00:00.000Z", 800),
      dropRow("weaviate", "e2e", "2026-07-06T10:00:00.000Z", 600), // 600 vs 800 = −25%
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      repository: "weaviate",
      job_name: "e2e",
      prevExecuted: 800,
      currExecuted: 600,
      dropPct: 0.25,
    });
  });

  it("flags an exact 10% drop (boundary is inclusive)", () => {
    const out = detectExecutedDrops([
      dropRow("r", "j", "2026-07-05T00:00:00.000Z", 100),
      dropRow("r", "j", "2026-07-06T00:00:00.000Z", 90), // exactly −10%
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dropPct).toBeCloseTo(0.1);
  });

  it("does not flag a stable / increased job or a sub-threshold dip", () => {
    expect(
      detectExecutedDrops([
        dropRow("r", "j", "2026-07-05T00:00:00.000Z", 500),
        dropRow("r", "j", "2026-07-06T00:00:00.000Z", 480), // −4%, under 10%
      ]),
    ).toEqual([]);
    expect(
      detectExecutedDrops([
        dropRow("r", "j", "2026-07-05T00:00:00.000Z", 500),
        dropRow("r", "j", "2026-07-06T00:00:00.000Z", 520), // increased
      ]),
    ).toEqual([]);
  });

  it("skips jobs with fewer than two runs", () => {
    expect(
      detectExecutedDrops([
        dropRow("r", "solo", "2026-07-06T00:00:00.000Z", 100),
      ]),
    ).toEqual([]);
  });

  it("ignores trivially small jobs (previous executed < MIN_PREV_EXECUTED)", () => {
    expect(
      detectExecutedDrops([
        dropRow("r", "tiny", "2026-07-05T00:00:00.000Z", 4),
        dropRow("r", "tiny", "2026-07-06T00:00:00.000Z", 1), // 75% drop but too small
      ]),
    ).toEqual([]);
  });

  it("counts a skip-rise as an executed drop (executed = total − skipped)", () => {
    const out = detectExecutedDrops([
      dropRow("r", "flaggate", "2026-07-05T00:00:00.000Z", 500, 0), // executed 500
      dropRow("r", "flaggate", "2026-07-06T00:00:00.000Z", 500, 300), // executed 200 → −60%
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ prevExecuted: 500, currExecuted: 200 });
  });

  it("compares the two most recent runs regardless of input order; groups by (repo, job)", () => {
    const out = detectExecutedDrops([
      dropRow("weaviate", "e2e", "2026-07-01T00:00:00.000Z", 100), // older — ignored
      dropRow("weaviate", "e2e", "2026-07-06T00:00:00.000Z", 600), // latest
      dropRow("weaviate", "e2e", "2026-07-05T00:00:00.000Z", 800), // previous
      dropRow("tools", "e2e", "2026-07-05T00:00:00.000Z", 200), // same name, other repo, stable
      dropRow("tools", "e2e", "2026-07-06T00:00:00.000Z", 200),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      repository: "weaviate",
      job_name: "e2e",
      prevExecuted: 800,
      currExecuted: 600,
    });
  });

  it("sorts flagged jobs by drop magnitude, largest first", () => {
    const out = detectExecutedDrops([
      dropRow("r", "small", "2026-07-05T00:00:00.000Z", 100),
      dropRow("r", "small", "2026-07-06T00:00:00.000Z", 85), // −15%
      dropRow("r", "big", "2026-07-05T00:00:00.000Z", 100),
      dropRow("r", "big", "2026-07-06T00:00:00.000Z", 40), // −60%
    ]);
    expect(out.map((d) => d.job_name)).toEqual(["big", "small"]);
  });

  it("does NOT flag a cross-version-only comparison (no same-version baseline)", () => {
    // Tests are skipped per version, so a 1.37 run executing fewer than a 1.36
    // run is expected, not a collapse — and there's no prior 1.37 to compare to.
    const out = detectExecutedDrops([
      dropRow("r", "e2e", "2026-07-05T00:00:00.000Z", 800, 0, "1.36"),
      dropRow("r", "e2e", "2026-07-06T00:00:00.000Z", 600, 0, "1.37"),
    ]);
    expect(out).toEqual([]);
  });

  it("compares against the most recent SAME-version run, skipping an interleaved other version", () => {
    const out = detectExecutedDrops([
      dropRow("r", "e2e", "2026-07-04T00:00:00.000Z", 800, 0, "1.37"), // 1.37 baseline
      dropRow("r", "e2e", "2026-07-05T00:00:00.000Z", 300, 0, "1.36"), // interleaved 1.36 — ignored
      dropRow("r", "e2e", "2026-07-06T00:00:00.000Z", 500, 0, "1.37"), // latest 1.37
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      versionMinor: "1.37",
      prevExecuted: 800, // the 07-04 1.37 run, NOT the 07-05 1.36 run
      currExecuted: 500,
    });
  });
});

describe("buildTestHistory", () => {
  const meta = { testSuite: "e2e", name: "test_x", framework: "pytest" };
  const pt = (
    status: TestCaseStatus,
    runStartedAt: string,
    over: Partial<TestHistoryPoint> = {},
  ): TestHistoryPoint => ({
    status,
    runStartedAt,
    versionMinor: "1.37",
    branch: "main",
    runStatus: status === "failed" ? "failure" : "success",
    runId: `run-${runStartedAt}`,
    jobUrl: "https://ci/job",
    errorMessage: null,
    failureType: null,
    durationMs: 0,
    ...over,
  });

  it("sorts chronologically, tallies pass/fail/skip, scores transition density", () => {
    const h = buildTestHistory(meta, [
      pt("failed", "2026-07-03T00:00:00.000Z"),
      pt("passed", "2026-07-01T00:00:00.000Z"),
      pt("failed", "2026-07-02T00:00:00.000Z"),
    ]);
    expect(h.points.map((p) => p.runStartedAt)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
      "2026-07-03T00:00:00.000Z",
    ]);
    expect(h).toMatchObject({ totalRuns: 3, passed: 1, failed: 2, skipped: 0 });
    // sequence pass,fail,fail → 1 transition over 3 obs → 1/2
    expect(h.flakinessScore).toBe(0.5);
  });

  it("scores a stable (all-passed) test as 0", () => {
    const h = buildTestHistory(meta, [
      pt("passed", "2026-07-01T00:00:00.000Z"),
      pt("passed", "2026-07-02T00:00:00.000Z"),
      pt("passed", "2026-07-03T00:00:00.000Z"),
    ]);
    expect(h.flakinessScore).toBe(0);
    expect(h).toMatchObject({ passed: 3, failed: 0 });
  });

  it("ignores skipped runs in the flake score but still counts them", () => {
    const h = buildTestHistory(meta, [
      pt("passed", "2026-07-01T00:00:00.000Z"),
      pt("skipped", "2026-07-02T00:00:00.000Z"),
      pt("failed", "2026-07-03T00:00:00.000Z"),
    ]);
    expect(h).toMatchObject({ passed: 1, failed: 1, skipped: 1, totalRuns: 3 });
    // passed→failed (skip ignored) = 1 transition over 2 obs → 1/1 = 1
    expect(h.flakinessScore).toBe(1);
  });

  it("scores 0 with fewer than two passed/failed observations", () => {
    const h = buildTestHistory(meta, [
      pt("passed", "2026-07-01T00:00:00.000Z"),
      pt("skipped", "2026-07-02T00:00:00.000Z"),
    ]);
    expect(h.flakinessScore).toBe(0);
  });

  it("handles an empty history", () => {
    const h = buildTestHistory(meta, []);
    expect(h).toMatchObject({ totalRuns: 0, passed: 0, failed: 0, points: [] });
    expect(h.flakinessScore).toBe(0);
  });
});
