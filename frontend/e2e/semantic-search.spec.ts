import { expect, test } from "@playwright/test";

test.describe("Semantic Search", () => {
  test("submits a query and returns ranked results", async ({ page }) => {
    await page.goto("/search/");

    // The textarea is pre-populated with an example AssertionError stack.
    const textarea = page.getByTestId("search-textarea");
    await expect(textarea).toBeVisible();
    await expect(textarea).not.toHaveValue("");

    await page.getByTestId("search-submit").click();

    // Wait for results.
    const results = page.getByTestId("search-results");
    await expect(results).toBeVisible({ timeout: 15_000 });

    const items = page.getByTestId("search-result");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);

    // First result should show a similarity percentage in the match badge.
    await expect(items.first()).toContainText(/match/i);
  });

  test("empty query disables the submit button", async ({ page }) => {
    await page.goto("/search/");
    // The textarea is pre-populated with EXAMPLE, so the button starts enabled.
    // Wait for that before clearing: it confirms the page has hydrated, so the
    // controlled-input onChange is wired and clearing actually updates `draft`.
    // Without this the fill races hydration and React reconciles the field back
    // to EXAMPLE, leaving the button enabled (a flaky failure).
    await expect(page.getByTestId("search-submit")).toBeEnabled();
    await page.getByTestId("search-textarea").fill("");
    await expect(page.getByTestId("search-submit")).toBeDisabled();
  });

  test("submitting filters results to failed status", async ({ page }) => {
    await page.goto("/search/");

    await page
      .getByTestId("search-textarea")
      .fill("snapshot restore failed assertion");
    await page.getByTestId("search-submit").click();

    const items = page.getByTestId("search-result");
    await expect(items.first()).toBeVisible({ timeout: 15_000 });

    // Every result should show the failed status badge.
    const count = await items.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      await expect(items.nth(i)).toContainText(/failed/i);
    }
  });
});
