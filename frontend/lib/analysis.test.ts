import { describe, it, expect } from "vitest";
import {
  isoDaysAgo,
  computeFlaky,
  deriveKpis,
  rollupRunsByMinor,
  FLAKES_RECENT_STATUSES,
  type FlakeRow,
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
  it("computes pass rate from run-level counts, plus avg duration + top failing suite", () => {
    const kpis = deriveKpis({
      totalRuns: 3,
      avgDurationMean: 1234.5,
      totalTests: 10,
      passedTests: 8,
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
    });
  });

  it("counts skipped in totalTests (denominator spans all statuses)", () => {
    const kpis = deriveKpis({
      totalRuns: 1,
      avgDurationMean: null,
      totalTests: 10, // 6 passed + 2 failed + 2 skipped
      passedTests: 6,
      failedSuiteGroups: [],
    });
    expect(kpis.totalCases).toBe(10);
    expect(kpis.passRate).toBe(0.6);
    expect(kpis.topFailingSuite).toBeNull();
    expect(kpis.avgRunDurationMs).toBe(0);
  });

  it("guards against divide-by-zero with no tests", () => {
    const kpis = deriveKpis({
      totalRuns: 0,
      avgDurationMean: null,
      totalTests: 0,
      passedTests: 0,
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
