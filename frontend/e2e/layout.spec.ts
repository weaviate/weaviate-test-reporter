import { expect, test } from "@playwright/test";

test.describe("Layout & navigation", () => {
  test("loads the app shell with brand + 3 nav links", async ({ page }) => {
    await page.goto("/");

    // Brand mark (Weaviate logo image) + sub-title in the sidebar.
    await expect(page.getByRole("img", { name: "Weaviate" })).toBeVisible();
    await expect(page.getByText("Test Reporter", { exact: true })).toBeVisible();

    // All three primary nav links are present. Use `exact: true` so the
    // brand link's aria-label ("Weaviate Test Reporter, go to Test
    // Explorer") doesn't shadow the sidebar nav link.
    await expect(
      page.getByRole("link", { name: "Test Explorer", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Semantic Search", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Metrics", exact: true })
    ).toBeVisible();
  });

  test("nav links route between tabs", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });

    await nav.getByRole("link", { name: "Semantic Search", exact: true }).click();
    await expect(page).toHaveURL(/\/search\/?$/);
    await expect(
      page.getByRole("heading", { name: /find tests that failed/i })
    ).toBeVisible();

    await nav.getByRole("link", { name: "Metrics", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    await expect(
      page.getByRole("heading", { name: /state of the suite/i })
    ).toBeVisible();

    await nav.getByRole("link", { name: "Test Explorer", exact: true }).click();
    await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/?$/);
    await expect(
      page.getByRole("heading", { name: /recent test runs/i })
    ).toBeVisible();
  });

  test("active nav link is marked with aria-current", async ({ page }) => {
    await page.goto("/dashboard/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    const active = nav.getByRole("link", { name: "Metrics", exact: true });
    await expect(active).toHaveAttribute("aria-current", "page");
  });
});
