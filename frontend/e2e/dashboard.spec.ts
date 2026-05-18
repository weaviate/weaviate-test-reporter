import { expect, test } from "@playwright/test";

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
});
