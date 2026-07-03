import { describe, it, expect } from "vitest";
import {
  isoDaysAgo,
  computeFlaky,
  deriveKpis,
  rollupRunsByMinor,
  summarizeRunCounts,
  bucketRunsByDay,
  FLAKES_RECENT_STATUSES,
  type FlakeRow,
  type TrendRunRow,
} from "./analysis";
import type { TestCaseStatus } from "./types";

const row = (
  test_suite: string,
  name: string,
  status: TestCaseStatus,
  framework = "pytest",
): FlakeRow => ({ test_suite, name, status, framework });

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
