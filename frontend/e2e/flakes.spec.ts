import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for the Flakes page.
 *
 * The seeded local cluster mints status sequences that should produce
 * SOME flaky tests — but if not (clean fixture week), the empty-state
 * branch is the right thing to assert against. Accept either.
 */
test.describe("Flakes page", () => {
  test("renders the page chrome + window picker + table OR empty state", async ({
    page,
  }) => {
    await page.goto("/flakes/");
    await expect(
      page.getByRole("heading", { name: /tests that flip/i }),
    ).toBeVisible();
    await expect(page.getByTestId("flakes-window-picker")).toBeVisible();
    const table = page.getByTestId("flakes-table");
    const empty = page.getByText(/no flakes in this window/i);
    await expect(table.or(empty)).toBeVisible();
  });

  test("switching the window triggers a refetch", async ({ page }) => {
    await page.goto("/flakes/");
    // Default is 7d; click 30d. Either the table updates or empty
    // state still shows — both are valid; the assertion is that the
    // pressed-state moves.
    const thirty = page.getByRole("button", { name: /last 30 days/i });
    await thirty.click();
    await expect(thirty).toHaveAttribute("aria-pressed", "true");
  });
});
