import { expect, test } from "@playwright/test";

/**
 * Filter bar tests.
 *
 * These rely on the seeded Weaviate having multiple repositories and
 * statuses present. The synthetic seed produces both success and
 * failure runs across "weaviate/weaviate-test-reporter"; the
 * ingest_local fixture-runs add more repositories.
 */

test.describe("Run filter bar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for the initial run list to render.
    await expect(page.getByTestId("run-row").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("free-text search narrows the result set", async ({ page }) => {
    const initial = await page.getByTestId("run-row").count();
    expect(initial).toBeGreaterThan(1);

    // Search for a term that the seed data includes (the branch convention
    // "feature/" or the actor "weaviate-bot"). Pick the most-common-ish.
    await page.getByTestId("run-search-input").fill("main");

    // Wait for the filter to take effect (live, no submit button).
    await expect
      .poll(async () => page.getByTestId("run-row").count(), { timeout: 8_000 })
      .toBeLessThanOrEqual(initial);

    // All visible rows should mention "main" somewhere in the row body.
    const rows = page.getByTestId("run-row");
    const count = await rows.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const row = rows.nth(i);
      await expect(row).toContainText(/main/, { ignoreCase: true });
    }
  });

  test("clearing the search restores the full list", async ({ page }) => {
    const initial = await page.getByTestId("run-row").count();

    await page.getByTestId("run-search-input").fill("zzzzzzz-no-match");
    await expect
      .poll(async () => page.getByTestId("run-row").count(), { timeout: 5_000 })
      .toBe(0);

    await page.getByTestId("run-search-input").fill("");
    await expect
      .poll(async () => page.getByTestId("run-row").count(), { timeout: 8_000 })
      .toBe(initial);
  });

  test("repository dropdown opens and shows available repos with counts", async ({
    page,
  }) => {
    const repoButton = page
      .getByTestId("filter-repository")
      .getByRole("button")
      .first();
    await repoButton.click();

    const optionList = page.getByTestId("filter-repository-options");
    await expect(optionList).toBeVisible();

    // At least one option from the seed should be present.
    await expect(optionList).toContainText("weaviate", { timeout: 5_000 });
  });

  test("checking a repository filters runs to that repo only", async ({
    page,
  }) => {
    await page.getByTestId("filter-repository").getByRole("button").first().click();

    const optionList = page.getByTestId("filter-repository-options");
    await expect(optionList).toBeVisible();

    // Pick the first option in the list and capture its value.
    const firstOption = optionList.getByRole("button").first();
    const repoLabel = (await firstOption.innerText()).split("\n")[0].trim();
    await firstOption.click();

    // The filter button now shows an active count badge.
    await expect(
      page.getByTestId("filter-repository").getByRole("button").first()
    ).toContainText("1");

    // Close the dropdown by clicking outside.
    await page.getByRole("heading", { name: /recent test runs/i }).click();

    // Every visible row should be from the selected repository.
    await expect(page.getByTestId("run-row").first()).toBeVisible({
      timeout: 8_000,
    });
    const rows = page.getByTestId("run-row");
    const count = await rows.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const repo = await rows.nth(i).getAttribute("data-run-repository");
      expect(repo).toBe(repoLabel);
    }
  });

  test("status filter narrows by run outcome", async ({ page }) => {
    await page.getByTestId("filter-status").getByRole("button").first().click();
    const opts = page.getByTestId("filter-status-options");
    await expect(opts).toBeVisible();

    // Pick "failure" if it exists in the seed.
    const failureOpt = opts.getByText("failure", { exact: true }).first();
    if ((await failureOpt.count()) > 0) {
      await failureOpt.click();

      await page.getByRole("heading", { name: /recent test runs/i }).click();

      const rows = page.getByTestId("run-row");
      await expect(rows.first()).toBeVisible({ timeout: 8_000 });
      const count = await rows.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        const status = await rows.nth(i).getAttribute("data-run-status");
        expect(status).toBe("failure");
      }
    }
  });

  test("Clear all resets every filter", async ({ page }) => {
    // Apply a search filter.
    await page.getByTestId("run-search-input").fill("main");
    await expect.poll(async () => page.getByTestId("run-row").count()).toBeGreaterThan(0);

    // "Clear all" appears now.
    const clearAll = page.getByTestId("filter-clear-all");
    await expect(clearAll).toBeVisible();
    await clearAll.click();

    await expect(page.getByTestId("run-search-input")).toHaveValue("");
    await expect(clearAll).toHaveCount(0);
  });
});
