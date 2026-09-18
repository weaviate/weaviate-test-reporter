import { expect, test, type Page, type Route } from "@playwright/test";
import type { DashboardKpis } from "../lib/types";
import type { TrendPoint } from "../lib/analysis";

async function mockDashboardApis(
  page: Page,
  opts?: {
    kpis?: DashboardKpis;
    trend?: TrendPoint[];
  },
) {
  const kpis: DashboardKpis = opts?.kpis ?? {
    passRate: 0.98,
    avgRunDurationMs: 42_000,
    topFailingSuite: { suite: "suite.alpha", count: 3 },
    infraFailureRuns: 0,
    totalRuns: 3,
    totalCases: 300,
    skippedCases: 0,
  };
  const trend: TrendPoint[] = opts?.trend ?? [
    {
      day: "2026-09-14",
      runs: 0,
      passingRuns: 0,
      tests: 0,
      testsPassed: 0,
      failures: 0,
      infraFailures: 0,
      testsSkipped: 0,
      passRate: null,
      avgDurationMs: null,
    },
    {
      day: "2026-09-15",
      runs: 1,
      passingRuns: 0,
      tests: 300,
      testsPassed: 40,
      failures: 250,
      infraFailures: 0,
      testsSkipped: 10,
      passRate: 40 / 290,
      avgDurationMs: 180_000,
    },
  ];
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case "/api/kpis":
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(kpis),
        });
      case "/api/drops":
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify([]),
        });
      case "/api/regressions":
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            regressions: [],
            newCount: 0,
            knownFlakyCount: 0,
            recurringCount: 0,
          }),
        });
      case "/api/clusters":
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            clusters: [],
            uncategorized: 0,
            totalFailures: 0,
          }),
        });
      case "/api/runs/distinct":
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify([]),
        });
      case "/api/trend":
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(trend),
        });
      default:
        return route.fallback();
    }
  });
}

test.describe("Metrics Dashboard", () => {
  test("renders all three KPI cards with computed values", async ({ page }) => {
    await page.goto("/dashboard/");

    const passRate = page.getByTestId("kpi-pass-rate");
    const avgDuration = page.getByTestId("kpi-avg-duration");
    const topSuite = page.getByTestId("kpi-top-failing-suite");

    await expect(passRate).toBeVisible({ timeout: 15_000 });
    await expect(avgDuration).toBeVisible();
    await expect(topSuite).toBeVisible();

    await expect(passRate).toContainText(/%/);
    await expect(avgDuration).toContainText(/\d+/);
    await expect(avgDuration).toContainText(/s|m|h/);
    await expect(topSuite).toContainText(/\d+/);
  });

  test("switching to 'All time' renders KPIs without GraphQL error", async ({ page }) => {
    // Regression test: a previous version interpolated `TestRun()` with
    // empty parens when no filter was active, and Weaviate's GraphQL
    // parser raised "Unexpected empty IN ()". Selecting All time must
    // produce a clean render.
    await page.goto("/dashboard/");
    await expect(page.getByTestId("kpi-pass-rate")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "All time" }).click();
    await expect(
      page.getByRole("button", { name: "All time" }),
    ).toHaveAttribute("aria-pressed", "true");

    // KPI cards must still be visible — no error banner.
    await expect(page.getByTestId("kpi-pass-rate")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/weaviate graphql error/i)).toHaveCount(0);
  });

  test("keeps the no-data outage marker visible when failures are high", async ({
    page,
  }) => {
    await mockDashboardApis(page);
    await page.goto("/dashboard/");

    const chart = page.getByTestId("trend-chart-failures");
    await expect(chart).toBeVisible({ timeout: 15_000 });

    const noDataBarHeight = Number(
      await chart.getByTestId("trend-no-data-marker").getAttribute("height"),
    );

    expect(noDataBarHeight).toBeGreaterThanOrEqual(5);
  });

  test("does not label infra-failure-only windows as a clean sweep", async ({
    page,
  }) => {
    await mockDashboardApis(page, {
      kpis: {
        passRate: 0,
        avgRunDurationMs: 0,
        topFailingSuite: null,
        infraFailureRuns: 2,
        totalRuns: 2,
        totalCases: 0,
        skippedCases: 0,
      },
      trend: [
        {
          day: "2026-09-14",
          runs: 2,
          passingRuns: 0,
          tests: 0,
          testsPassed: 0,
          failures: 0,
          infraFailures: 2,
          testsSkipped: 0,
          passRate: null,
          avgDurationMs: null,
        },
      ],
    });
    await page.goto("/dashboard/");

    const topSuite = page.getByTestId("kpi-top-failing-suite");
    await expect(topSuite).toBeVisible({ timeout: 15_000 });
    await expect(topSuite).toContainText("0");
    await expect(topSuite).toContainText(
      "No failed TestCases were reported; 2 TestRuns infra-failed before tests started.",
    );
    await expect(topSuite).not.toContainText("clean sweep");
  });
});
