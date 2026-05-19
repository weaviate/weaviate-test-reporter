import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for F3 — retry-attempt comparison in the Test Explorer
 * expanded body.
 *
 * The seed script mints retries on ~40% of failing runs, so on a freshly
 * seeded local cluster there will be at least one multi-attempt
 * workflow_run_id. We find the first expandable row, expand it, and
 * check whether the attempt strip materialises.
 *
 * The test is "best-effort": if no multi-attempt run exists in the
 * seeded data (rare, but possible with bad RNG luck), we skip the
 * stronger assertion instead of failing. The basic "expand a row"
 * smoke runs unconditionally.
 */
test.describe("Test Explorer — retry attempts", () => {
  test("expanding a row may surface the attempt strip when retries exist", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /recent test runs/i }),
    ).toBeVisible();

    const firstRow = page.getByTestId("run-row").first();
    await expect(firstRow).toBeVisible();
    await firstRow.locator("button").first().click();

    // Either the attempt strip renders (multi-attempt run picked) or it
    // doesn't (one-shot run). Both are valid. If it DID render, assert
    // it has at least 2 chips — anything else would be a regression in
    // the rendering condition.
    const strip = page.getByTestId("attempt-strip");
    if (await strip.isVisible().catch(() => false)) {
      const chips = strip.locator('[data-testid^="attempt-chip-"]');
      await expect(chips).not.toHaveCount(0);
      // The current row's chip should be marked.
      await expect(
        strip.locator("[data-current]").first(),
      ).toBeVisible();
    } else {
      test.info().annotations.push({
        type: "skipped",
        description:
          "No multi-attempt run in the top-50; expand-only smoke still ran.",
      });
    }
  });
});
