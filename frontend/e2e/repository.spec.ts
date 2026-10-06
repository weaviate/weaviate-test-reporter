import { expect, test, type Locator } from "@playwright/test";

/**
 * Repository scoping: the sidebar selects one repository and every page shows
 * only its data. Relies on seed_local.py: 10 runs in the default repository
 * (weaviate/weaviate-e2e-tests) and 4 runs in weaviate/weaviate whose only
 * flaky test is CORE_FLAKY. The newest weaviate/weaviate run passed.
 */
const E2E = "weaviate/weaviate-e2e-tests";
const CORE = "weaviate/weaviate";
const CORE_RUNS = 4;
const CORE_SUITE = "github.com/weaviate/weaviate/test/acceptance/replication";
const CORE_FLAKY = "TestCoreOnly_ReplicaRepairFlaky";
const CORE_QS = `repo=${encodeURIComponent(CORE)}`;

function attrs(rows: Locator, name: string): Promise<(string | null)[]> {
  return rows.evaluateAll((els, n) => els.map((e) => e.getAttribute(n)), name);
}

test.describe("Repository selector", () => {
  test("defaults to the e2e repository and lists every repository", async ({
    page,
  }) => {
    await page.goto("/");
    const select = page.getByTestId("repository-select");
    await expect(select).toHaveValue(E2E);
    await expect(select.locator("option")).toHaveText([E2E, CORE]);
  });

  test("the default view shows only e2e runs", async ({ page }) => {
    await page.goto("/");
    const rows = page.getByTestId("run-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const repos = await attrs(rows, "data-run-repository");
    expect(new Set(repos)).toEqual(new Set([E2E]));
  });

  test("switching scopes the runs and carries the choice across pages", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("repository-select").selectOption(CORE);
    await expect(page).toHaveURL(new RegExp(`/\\?${CORE_QS}$`));

    const rows = page.getByTestId("run-row");
    await expect(rows).toHaveCount(CORE_RUNS, { timeout: 15_000 });
    const repos = await attrs(rows, "data-run-repository");
    expect(new Set(repos)).toEqual(new Set([CORE]));

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Flakes" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/flakes\\?${CORE_QS}$`));
    await expect(page.getByTestId("repository-select")).toHaveValue(CORE);
  });

  test("switching drops filters that belong to the previous repository", async ({
    page,
  }) => {
    // 1.37 exists only in the e2e seed; carried over, it would hide every
    // core run.
    await page.goto("/?versionMinor=1.37");
    await expect(page.getByTestId("filter-clear-all")).toBeVisible();

    await page.getByTestId("repository-select").selectOption(CORE);
    await expect(page.getByTestId("run-row")).toHaveCount(CORE_RUNS, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("filter-clear-all")).toHaveCount(0);
  });

  test("flakes and their history links stay within the repository", async ({
    page,
  }) => {
    // Three page loads, each a fresh scan in the dev server.
    test.slow();
    await page.goto(`/flakes?${CORE_QS}`);
    const coreRows = page.getByTestId("flake-row");
    await expect(coreRows.first()).toBeVisible({ timeout: 30_000 });
    expect(await attrs(coreRows, "data-flake-name")).toEqual([CORE_FLAKY]);

    const link = page.getByTestId("flake-history-link");
    await expect(link).toHaveAttribute("href", new RegExp(`&${CORE_QS}$`));
    await link.click();
    await expect(page.getByTestId("history-timeline")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("test-history-back")).toHaveAttribute(
      "href",
      `/flakes?${CORE_QS}`,
    );

    // The e2e seed may have no flakes of its own; a leak would still list
    // CORE_FLAKY, whose four runs form one group.
    await page.goto("/flakes");
    await expect(
      page
        .getByText("No flakes in this window")
        .or(page.getByTestId("flake-row").first()),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-flake-name="${CORE_FLAKY}"]`)).toHaveCount(
      0,
    );
  });

  test("a linked run from another repository switches the selection and drops filters", async ({
    page,
    request,
  }) => {
    const res = await request.get(
      `/api/runs?repository=${encodeURIComponent(CORE)}&limit=1`,
    );
    const [run] = (await res.json()) as Array<{ uuid: string }>;

    // versionMinor belongs to the e2e repository the link was opened from.
    await page.goto(`/?versionMinor=1.37&run=${run.uuid}`);
    await expect(page.getByTestId("repository-select")).toHaveValue(CORE);
    await expect(page).toHaveURL(new RegExp(`/\\?run=${run.uuid}&${CORE_QS}$`));
    await expect(
      page.getByTestId("pinned-run").getByTestId("run-row"),
    ).toHaveAttribute("data-run-repository", CORE);
  });
});

test.describe("Repository-scoped API", () => {
  test("rejects a malformed repository", async ({ request }) => {
    const res = await request.get("/api/flakes?repository=not-a-repo");
    expect(res.status()).toBe(400);
  });

  test("KPIs count only the requested repository's runs", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/kpis?repository=${encodeURIComponent(CORE)}`,
    );
    expect(res.ok()).toBe(true);
    expect((await res.json()).totalRuns).toBe(CORE_RUNS);
  });

  test("KPIs for a window without failures still report pass rate and duration", async ({
    request,
  }) => {
    const runs = await request.get(
      `/api/runs?repository=${encodeURIComponent(CORE)}&limit=1`,
    );
    const [latest] = (await runs.json()) as Array<{
      status: string;
      started_at: string;
    }>;
    expect(latest.status).toBe("success");

    const res = await request.get(
      `/api/kpis?repository=${encodeURIComponent(CORE)}` +
        `&since=${encodeURIComponent(latest.started_at)}`,
    );
    expect(res.status()).toBe(200);
    const kpis = await res.json();
    expect(kpis.totalRuns).toBe(1);
    expect(kpis.passRate).toBe(1);
    expect(kpis.avgRunDurationMs).toBeGreaterThan(0);
    expect(kpis.topFailingSuite).toBeNull();
  });

  test("a repository without runs gets empty results, not errors", async ({
    request,
  }) => {
    const none = encodeURIComponent("nobody/none");
    const kpis = await request.get(`/api/kpis?repository=${none}`);
    expect(kpis.status()).toBe(200);
    expect((await kpis.json()).totalRuns).toBe(0);

    const branches = await request.get(
      `/api/runs/distinct?repository=${none}&property=branch`,
    );
    expect(branches.status()).toBe(200);
    expect(await branches.json()).toEqual([]);
  });

  test("semantic search returns only the requested repository's cases", async ({
    request,
  }) => {
    const search = async (repository: string) => {
      const res = await request.post("/api/search", {
        data: {
          repository,
          query: "replica repair did not converge",
          failedOnly: true,
        },
      });
      expect(res.ok()).toBe(true);
      return ((await res.json()) as Array<{ test_suite: string }>).map(
        (c) => c.test_suite,
      );
    };
    const core = await search(CORE);
    expect(core.length).toBeGreaterThan(0);
    expect(new Set(core)).toEqual(new Set([CORE_SUITE]));
    expect(await search(E2E)).not.toContain(CORE_SUITE);
  });
});
