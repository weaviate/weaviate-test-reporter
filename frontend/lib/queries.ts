/**
 * Client-side data API for the dashboard.
 *
 * The browser no longer talks to Weaviate directly — GraphQL is being
 * deprecated, and the cluster URL/key must stay server-side. Each function
 * below fetches a same-origin `/api/*` route handler, which runs the actual
 * Weaviate query with the official TypeScript client (see
 * `lib/weaviate/queries.server.ts`).
 *
 * The PUBLIC SHAPE of this module is unchanged — same function names, args,
 * and return types — so pages, components, and the `useAsync` hook are
 * untouched by the migration.
 */
import type {
  TestRun,
  TestCase,
  DashboardKpis,
  VersionRollup,
  FlakyTest,
  RunFilters,
  TrendFilters,
} from "./types";
import {
  API_TIMEOUTS_MS,
  RECENT_RUNS_LIMIT,
  type TargetVector,
  type FlakesWindow,
} from "./constants";
import type { TrendPoint, ExecutedDrop, TestHistory } from "./analysis";

// Re-exports so existing `import { ... } from "@/lib/queries"` sites keep
// working without edits.
export { isoDaysAgo } from "./analysis";
export type {
  TrendPoint,
  ExecutedDrop,
  TestHistory,
  TestHistoryPoint,
} from "./analysis";
export { TARGET_VECTORS, DEFAULT_TARGET_VECTOR } from "./constants";
export type { TargetVector, FlakesWindow } from "./constants";
export type { RunFilters, TrendFilters } from "./types";

// ---------- fetch helper ----------

async function apiFetch<T>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      // Route handlers return `{ error }` on failure — surface it verbatim so
      // the UI's ErrorState shows the underlying Weaviate message.
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        /* non-JSON error body — keep the status line */
      }
      throw new Error(`${label}: ${message}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function apiGet<T>(path: string, timeoutMs: number, label: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" }, timeoutMs, label);
}

function apiPost<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return apiFetch<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
    label,
  );
}

// ---------- queries ----------

export async function fetchRecentRuns(
  filters: RunFilters = {},
  limit = RECENT_RUNS_LIMIT,
): Promise<TestRun[]> {
  const p = new URLSearchParams();
  const term = filters.search?.trim();
  if (term) p.set("search", term);
  for (const r of filters.repositories ?? []) p.append("repository", r);
  for (const s of filters.statuses ?? []) p.append("status", s);
  for (const v of filters.versionMinors ?? []) p.append("versionMinor", v);
  for (const v of filters.versionFulls ?? []) p.append("versionFull", v);
  p.set("limit", String(limit));
  return apiGet<TestRun[]>(
    `/api/runs?${p.toString()}`,
    API_TIMEOUTS_MS.default,
    "Fetch runs",
  );
}

export async function fetchDistinctRunValues(
  property:
    | "repository"
    | "branch"
    | "actor"
    | "status"
    | "version_full"
    | "version_minor",
): Promise<Array<{ value: string; count: number }>> {
  return apiGet(
    `/api/runs/distinct?property=${encodeURIComponent(property)}`,
    API_TIMEOUTS_MS.default,
    "Fetch filter values",
  );
}

export async function fetchVersionRollup(): Promise<VersionRollup[]> {
  return apiGet<VersionRollup[]>(
    `/api/versions`,
    API_TIMEOUTS_MS.default,
    "Fetch versions",
  );
}

export async function fetchCasesForRun(
  runUuid: string,
  opts: { failedOnly?: boolean; limit?: number } = {},
): Promise<TestCase[]> {
  const p = new URLSearchParams({ runUuid });
  if (opts.failedOnly) p.set("failedOnly", "true");
  if (opts.limit != null) p.set("limit", String(opts.limit));
  return apiGet<TestCase[]>(
    `/api/cases?${p.toString()}`,
    API_TIMEOUTS_MS.default,
    "Fetch cases",
  );
}

export async function semanticSearch(
  query: string,
  opts: {
    limit?: number;
    failedOnly?: boolean;
    targetVector?: TargetVector;
  } = {},
): Promise<TestCase[]> {
  if (!query.trim()) return [];
  return apiPost<TestCase[]>(
    `/api/search`,
    {
      query,
      limit: opts.limit,
      failedOnly: opts.failedOnly,
      targetVector: opts.targetVector,
    },
    API_TIMEOUTS_MS.search,
    "Semantic search",
  );
}

export async function fetchDashboardKpis(
  sinceIso?: string,
): Promise<DashboardKpis> {
  const p = new URLSearchParams();
  if (sinceIso) p.set("since", sinceIso);
  const qs = p.toString();
  return apiGet<DashboardKpis>(
    `/api/kpis${qs ? `?${qs}` : ""}`,
    API_TIMEOUTS_MS.default,
    "Fetch metrics",
  );
}

export async function fetchRunTrend(
  sinceIso?: string,
  filters: TrendFilters = {},
): Promise<TrendPoint[]> {
  const p = new URLSearchParams();
  if (sinceIso) p.set("since", sinceIso);
  for (const r of filters.repositories ?? []) p.append("repository", r);
  for (const b of filters.branches ?? []) p.append("branch", b);
  for (const v of filters.versionMinors ?? []) p.append("versionMinor", v);
  const qs = p.toString();
  return apiGet<TrendPoint[]>(
    `/api/trend${qs ? `?${qs}` : ""}`,
    API_TIMEOUTS_MS.default,
    "Fetch trend",
  );
}

export async function fetchExecutedDrops(
  sinceIso?: string,
): Promise<ExecutedDrop[]> {
  const p = new URLSearchParams();
  if (sinceIso) p.set("since", sinceIso);
  const qs = p.toString();
  return apiGet<ExecutedDrop[]>(
    `/api/drops${qs ? `?${qs}` : ""}`,
    API_TIMEOUTS_MS.default,
    "Fetch executed drops",
  );
}

export async function fetchTestHistory(
  testSuite: string,
  name: string,
): Promise<TestHistory> {
  const p = new URLSearchParams({ suite: testSuite, name });
  return apiGet<TestHistory>(
    `/api/test-history?${p.toString()}`,
    API_TIMEOUTS_MS.default,
    "Fetch test history",
  );
}

export async function fetchFlakyTests(
  window: FlakesWindow,
  opts: { minRuns?: number } = {},
): Promise<FlakyTest[]> {
  const p = new URLSearchParams({ window });
  if (opts.minRuns != null) p.set("minRuns", String(opts.minRuns));
  return apiGet<FlakyTest[]>(
    `/api/flakes?${p.toString()}`,
    API_TIMEOUTS_MS.flakes,
    "Fetch flakes",
  );
}
