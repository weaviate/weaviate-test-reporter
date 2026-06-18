/**
 * Shared, secret-free constants — safe to import from both client and
 * server modules. Weaviate connection settings live in `server-env.ts`
 * (server-only); nothing here is sensitive.
 */

/** Weaviate collection names — mirror `.project/02-weaviate-schema.md`. */
export const COLLECTIONS = {
  TEST_RUN: "TestRun",
  TEST_CASE: "TestCase",
} as const;

/** Default result limits — kept identical to the pre-migration GraphQL layer. */
export const RECENT_RUNS_LIMIT = 50;
export const SEARCH_LIMIT = 20;
export const CASES_LIMIT = 200;

/**
 * Client-side fetch() timeouts (ms) for the same-origin `/api/*` calls.
 * Higher than the old per-GraphQL-call budgets because each route handler
 * may now run several Weaviate calls server-side, and `/api/flakes`
 * paginates the full window in a single request.
 */
export const API_TIMEOUTS_MS = {
  default: 30_000,
  search: 30_000,
  flakes: 120_000,
} as const;

/** Named vectors on TestCase (see `.project/02-weaviate-schema.md`). The
 *  semantic-search UI lets the user pick which one to query against. */
export const TARGET_VECTORS = ["stack_trace", "error_message", "name"] as const;
export type TargetVector = (typeof TARGET_VECTORS)[number];
export const DEFAULT_TARGET_VECTOR: TargetVector = "stack_trace";

/** Flakiness analysis window. */
export type FlakesWindow = "7d" | "30d";
