import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchRecentRuns,
  fetchRunById,
  fetchDistinctRunValues,
  fetchRepositories,
  fetchCasesForRun,
  semanticSearch,
  fetchDashboardKpis,
  fetchFlakyTests,
  fetchVersionRollup,
  fetchRunTrend,
  fetchExecutedDrops,
  fetchRegressions,
  fetchFailureClusters,
  fetchTestHistory,
} from "./queries";

const REPO = "weaviate/weaviate";

/** Build a minimal fetch Response stand-in. */
function res(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => data,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL the most recent fetch was called with, parsed. */
function lastUrl(): URL {
  const [input] = fetchMock.mock.calls.at(-1)!;
  return new URL(input as string, "http://localhost");
}
function lastInit(): RequestInit {
  return fetchMock.mock.calls.at(-1)![1] as RequestInit;
}

describe("fetchRecentRuns", () => {
  it("serializes filters into repeatable query params and hits /api/runs", async () => {
    fetchMock.mockResolvedValue(res([]));
    await fetchRecentRuns(REPO, {
      search: "  main  ",
      statuses: ["success"],
      versionMinors: ["1.37"],
      versionFulls: ["1.37.5"],
    });
    const u = lastUrl();
    expect(u.pathname).toBe("/api/runs");
    expect(u.searchParams.get("search")).toBe("main"); // trimmed
    expect(u.searchParams.getAll("repository")).toEqual([REPO]);
    expect(u.searchParams.getAll("status")).toEqual(["success"]);
    expect(u.searchParams.getAll("versionMinor")).toEqual(["1.37"]);
    expect(u.searchParams.getAll("versionFull")).toEqual(["1.37.5"]);
    expect(u.searchParams.get("limit")).toBe("50");
  });

  it("omits empty filters and returns the parsed payload", async () => {
    const runs = [{ uuid: "r1" }];
    fetchMock.mockResolvedValue(res(runs));
    const out = await fetchRecentRuns(REPO);
    expect(lastUrl().searchParams.has("search")).toBe(false);
    expect(out).toEqual(runs);
  });
});

describe("fetchRunById", () => {
  it("encodes the uuid and hits /api/run", async () => {
    fetchMock.mockResolvedValue(res({ uuid: "run-1" }));
    // A uuid with special chars proves the value is URL-encoded.
    const out = await fetchRunById("a/b?c d");
    const u = lastUrl();
    expect(u.pathname).toBe("/api/run");
    expect(u.searchParams.get("uuid")).toBe("a/b?c d");
    expect(out).toEqual({ uuid: "run-1" });
  });
});

describe("fetchDistinctRunValues", () => {
  it("passes the repository + property and hits /api/runs/distinct", async () => {
    fetchMock.mockResolvedValue(res([{ value: "1.37", count: 3 }]));
    const out = await fetchDistinctRunValues(REPO, "version_minor");
    const u = lastUrl();
    expect(u.pathname).toBe("/api/runs/distinct");
    expect(u.searchParams.get("property")).toBe("version_minor");
    expect(u.searchParams.get("repository")).toBe(REPO);
    expect(out).toEqual([{ value: "1.37", count: 3 }]);
  });
});

describe("fetchRepositories", () => {
  it("hits /api/repositories with no params", async () => {
    fetchMock.mockResolvedValue(res([{ value: REPO, count: 3 }]));
    const out = await fetchRepositories();
    const u = lastUrl();
    expect(u.pathname).toBe("/api/repositories");
    expect([...u.searchParams.keys()]).toEqual([]);
    expect(out).toEqual([{ value: REPO, count: 3 }]);
  });
});

describe("fetchCasesForRun", () => {
  it("encodes runUuid + failedOnly", async () => {
    fetchMock.mockResolvedValue(res([]));
    await fetchCasesForRun("uuid-1", { failedOnly: true, limit: 10 });
    const u = lastUrl();
    expect(u.pathname).toBe("/api/cases");
    expect(u.searchParams.get("runUuid")).toBe("uuid-1");
    expect(u.searchParams.get("failedOnly")).toBe("true");
    expect(u.searchParams.get("limit")).toBe("10");
  });
});

describe("semanticSearch", () => {
  it("POSTs the query body to /api/search", async () => {
    fetchMock.mockResolvedValue(res([]));
    await semanticSearch(REPO, "connection timeout", {
      targetVector: "error_message",
      failedOnly: true,
      limit: 5,
    });
    const u = lastUrl();
    expect(u.pathname).toBe("/api/search");
    const init = lastInit();
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      repository: REPO,
      query: "connection timeout",
      targetVector: "error_message",
      failedOnly: true,
      limit: 5,
    });
  });

  it("short-circuits an empty query without calling fetch", async () => {
    const out = await semanticSearch(REPO, "   ");
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchDashboardKpis", () => {
  it("includes ?since when provided, omits it otherwise", async () => {
    fetchMock.mockResolvedValue(res({ passRate: 1 }));
    await fetchDashboardKpis(REPO, "2026-06-10T00:00:00.000Z");
    expect(lastUrl().searchParams.get("since")).toBe(
      "2026-06-10T00:00:00.000Z",
    );
    expect(lastUrl().searchParams.get("repository")).toBe(REPO);
    await fetchDashboardKpis(REPO);
    expect(lastUrl().searchParams.has("since")).toBe(false);
    expect(lastUrl().searchParams.get("repository")).toBe(REPO);
  });
});

describe("fetchFlakyTests", () => {
  it("passes window + minRuns", async () => {
    fetchMock.mockResolvedValue(res([]));
    await fetchFlakyTests(REPO, "30d", { minRuns: 5 });
    const u = lastUrl();
    expect(u.pathname).toBe("/api/flakes");
    expect(u.searchParams.get("window")).toBe("30d");
    expect(u.searchParams.get("minRuns")).toBe("5");
    expect(u.searchParams.get("repository")).toBe(REPO);
  });
});

describe("repository scoping", () => {
  // Every repo-scoped GET sends exactly one `repository` param.
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["/api/versions", () => fetchVersionRollup(REPO)],
    [
      "/api/trend",
      () => fetchRunTrend(REPO, undefined, { branches: ["main"] }),
    ],
    ["/api/drops", () => fetchExecutedDrops(REPO)],
    ["/api/regressions", () => fetchRegressions(REPO, 7)],
    ["/api/clusters", () => fetchFailureClusters(REPO, 7)],
    ["/api/test-history", () => fetchTestHistory(REPO, "suite", "name")],
  ];
  for (const [path, call] of calls) {
    it(`${path} carries the repository`, async () => {
      fetchMock.mockResolvedValue(res({}));
      await call();
      const u = lastUrl();
      expect(u.pathname).toBe(path);
      expect(u.searchParams.getAll("repository")).toEqual([REPO]);
    });
  }
});

describe("error handling", () => {
  it("throws with the route's { error } message on a non-OK response", async () => {
    fetchMock.mockResolvedValue(
      res({ error: "Weaviate exploded" }, false, 500),
    );
    await expect(fetchVersionRollupSafe()).rejects.toThrow(/Weaviate exploded/);
  });
});

// Imported lazily to keep the error-handling describe self-contained.
async function fetchVersionRollupSafe() {
  const { fetchVersionRollup } = await import("./queries");
  return fetchVersionRollup(REPO);
}
