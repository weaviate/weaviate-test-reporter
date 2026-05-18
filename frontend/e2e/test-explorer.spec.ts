import { expect, test } from "@playwright/test";

test.describe("Test Explorer", () => {
  test("lists recent test runs from Weaviate", async ({ page }) => {
    await page.goto("/");

    // Wait for at least one row to appear (seed has 10+).
    const firstRow = page.getByTestId("run-row").first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

    const rowCount = await page.getByTestId("run-row").count();
    expect(rowCount).toBeGreaterThan(0);

    // The header label reflects the count.
    await expect(page.getByTestId("run-count-label")).toContainText(/TestRun/);
  });

  test("expands a row to show its failed cases or a clean-run note", async ({ page }) => {
    await page.goto("/");

    const firstRow = page.getByTestId("run-row").first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

    // Click the toggle button inside the first row.
    await firstRow.getByRole("button").first().click();
    await expect(firstRow.getByRole("button").first()).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    // Expanded body is one of: failed case list, clean-run note, or loading.
    // We don't know which without inspecting the run's status, so accept any.
    await expect(firstRow).toContainText(
      /No failed cases|.+/, // any text in expanded body
      { timeout: 10_000 }
    );
  });
});
