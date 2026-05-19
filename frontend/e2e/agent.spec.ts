import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for the "Ask your tests" tab.
 *
 * The Query Agent is a Weaviate Cloud-only service (separate API at
 * api.agents.weaviate.io with monthly quotas). We do NOT exercise a
 * real agent call from CI — that would consume the org-wide free
 * allowance on every PR and won't work against the local testcontainers
 * Weaviate the suite already seeds.
 *
 * What we DO test:
 *   1. Tab is hidden in the sidebar when running against a non-WCD
 *      `NEXT_PUBLIC_WEAVIATE_URL` (the default in CI is localhost).
 *   2. Direct-URL navigation to `/agent` lands on the "not available"
 *      empty state rather than crashing or making a network call.
 */
test.describe("Ask your tests (Query Agent)", () => {
  test("sidebar entry is hidden against a local Weaviate URL", async ({
    page,
  }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    // Sentinel: at least one of the always-present nav links must be
    // visible before we assert the gated one is absent — otherwise the
    // test would pass on a half-rendered page.
    await expect(
      nav.getByRole("link", { name: "Test Explorer", exact: true }),
    ).toBeVisible();
    await expect(
      nav.getByRole("link", { name: "Ask your tests", exact: true }),
    ).toHaveCount(0);
  });

  test("/agent renders the not-available state against a local URL", async ({
    page,
  }) => {
    await page.goto("/agent/");
    await expect(
      page.getByRole("heading", { name: /query agent/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/requires a weaviate cloud instance/i),
    ).toBeVisible();
    // The chat scroll area must NOT mount; the agent never gets called.
    await expect(page.getByTestId("agent-chat-scroll")).toHaveCount(0);
  });
});
