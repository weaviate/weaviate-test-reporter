import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for the /versions landing page.
 *
 * Assumes the seeded local data (action/scripts/seed_local.py) includes
 * synthetic Weaviate versions across at least one minor lineage. When
 * the dataset is genuinely empty the empty state is rendered instead —
 * the test accepts either branch so it's robust against a clean cluster.
 */
test.describe("Versions landing page", () => {
  test("renders the page chrome and either cards or the empty state", async ({
    page,
  }) => {
    await page.goto("/versions/");

    await expect(
      page.getByRole("heading", { name: /by version under test/i }),
    ).toBeVisible();

    const grid = page.getByTestId("version-grid");
    const empty = page.getByText(/no version-labeled runs yet/i);

    // Whichever lands, exactly one of these should be visible.
    await expect(grid.or(empty)).toBeVisible();
  });

  test("clicking a version card deep-links to the Test Explorer with the minor pre-filtered", async ({
    page,
  }) => {
    await page.goto("/versions/");

    const grid = page.getByTestId("version-grid");
    if (!(await grid.isVisible().catch(() => false))) {
      test.skip(true, "No version-labeled data seeded — empty state shown.");
    }

    const firstCard = grid.locator('[data-testid^="version-card-"]').first();
    await expect(firstCard).toBeVisible();
    const minor = (await firstCard.getAttribute("data-testid"))!.replace(
      "version-card-",
      "",
    );

    await firstCard.click();
    await expect(page).toHaveURL(
      new RegExp(`/\\?versionMinor=${minor.replace(/\./g, "\\.")}`),
    );
    await expect(
      page.getByRole("heading", { name: /recent test runs/i }),
    ).toBeVisible();
  });

  test("Versions nav item lights up with aria-current when on /versions", async ({
    page,
  }) => {
    await page.goto("/versions/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    const active = nav.getByRole("link", { name: "Versions", exact: true });
    await expect(active).toHaveAttribute("aria-current", "page");
  });
});
