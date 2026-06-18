import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchRecentRuns,
  fetchDistinctRunValues,
  fetchCasesForRun,
  semanticSearch,
  fetchDashboardKpis,
  fetchFlakyTests,
} from "./queries";

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
    await fetchRecentRuns({
      search: "  main  ",
      repositories: ["a", "b"],
      statuses: ["success"],
      versionMinors: ["1.37"],
      versionFulls: ["1.37.5"],
    });
    const u = lastUrl();
    expect(u.pathname).toBe("/api/runs");
    expect(u.searchParams.get("search")).toBe("main"); // trimmed
    expect(u.searchParams.getAll("repository")).toEqual(["a", "b"]);
    expect(u.searchParams.getAll("status")).toEqual(["success"]);
    expect(u.searchParams.getAll("versionMinor")).toEqual(["1.37"]);
    expect(u.searchParams.getAll("versionFull")).toEqual(["1.37.5"]);
    expect(u.searchParams.get("limit")).toBe("50");
  });

  it("omits empty filters and returns the parsed payload", async () => {
    const runs = [{ uuid: "r1" }];
    fetchMock.mockResolvedValue(res(runs));
    const out = await fetchRecentRuns();
    expect(lastUrl().searchParams.has("search")).toBe(false);
    expect(out).toEqual(runs);
  });
});

describe("fetchDistinctRunValues", () => {
  it("passes the property and hits /api/runs/distinct", async () => {
    fetchMock.mockResolvedValue(res([{ value: "weaviate", count: 3 }]));
    const out = await fetchDistinctRunValues("repository");
    const u = lastUrl();
    expect(u.pathname).toBe("/api/runs/distinct");
    expect(u.searchParams.get("property")).toBe("repository");
    expect(out).toEqual([{ value: "weaviate", count: 3 }]);
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
    await semanticSearch("connection timeout", {
      targetVector: "error_message",
      failedOnly: true,
      limit: 5,
    });
    const u = lastUrl();
    expect(u.pathname).toBe("/api/search");
    const init = lastInit();
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "connection timeout",
      targetVector: "error_message",
      failedOnly: true,
      limit: 5,
    });
  });

  it("short-circuits an empty query without calling fetch", async () => {
    const out = await semanticSearch("   ");
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchDashboardKpis", () => {
  it("includes ?since when provided, omits it otherwise", async () => {
    fetchMock.mockResolvedValue(res({ passRate: 1 }));
    await fetchDashboardKpis("2026-06-10T00:00:00.000Z");
    expect(lastUrl().searchParams.get("since")).toBe(
      "2026-06-10T00:00:00.000Z",
    );
    await fetchDashboardKpis();
    expect(lastUrl().searchParams.has("since")).toBe(false);
  });
});

describe("fetchFlakyTests", () => {
  it("passes window + minRuns", async () => {
    fetchMock.mockResolvedValue(res([]));
    await fetchFlakyTests("30d", { minRuns: 5 });
    const u = lastUrl();
    expect(u.pathname).toBe("/api/flakes");
    expect(u.searchParams.get("window")).toBe("30d");
    expect(u.searchParams.get("minRuns")).toBe("5");
  });
});

describe("error handling", () => {
  it("throws with the route's { error } message on a non-OK response", async () => {
    fetchMock.mockResolvedValue(res({ error: "Weaviate exploded" }, false, 500));
    await expect(fetchVersionRollupSafe()).rejects.toThrow(/Weaviate exploded/);
  });
});

// Imported lazily to keep the error-handling describe self-contained.
async function fetchVersionRollupSafe() {
  const { fetchVersionRollup } = await import("./queries");
  return fetchVersionRollup();
}
