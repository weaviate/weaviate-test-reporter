/**
 * Browser-side Weaviate client.
 *
 * Weaviate's official TS client (`weaviate-client`) bundles gRPC over
 * `@grpc/grpc-js`, which depends on Node.js APIs (net, http2). A static
 * SPA cannot use it.
 *
 * Practical path for a browser-only deployment: hit Weaviate's HTTP
 * surface directly. We use:
 *
 *   - REST `/v1/meta`, `/v1/objects/...` for non-query operations.
 *   - GraphQL `/v1/graphql` for everything query-shaped (filtered fetch,
 *     nearText, aggregate). Queries are parameterized with GraphQL
 *     variables so user input never participates in the query text.
 *
 * GraphQL on Weaviate is on a long deprecation track (per the v4 client
 * team), but it remains the only stable browser-accessible query surface
 * today. When Weaviate ships a gRPC-Web gateway or a browser bundle of
 * weaviate-client, swap this layer out — the queries.ts API contract is
 * designed to survive the change.
 */
import { env, envIsConfigured } from "./env";

export const COLLECTIONS = {
  TEST_RUN: "TestRun",
  TEST_CASE: "TestCase",
} as const;

// Default request timeouts. Aggregation queries are fast; semantic search
// can be slower (vector lookup + filter). Both can be overridden per-call.
export const DEFAULT_TIMEOUTS_MS = {
  fast: 5_000,
  search: 15_000,
} as const;

function baseUrl(): string {
  if (!envIsConfigured()) {
    throw new Error(
      "NEXT_PUBLIC_WEAVIATE_URL is not set. Configure it at build time " +
        "or in the deployment environment before serving the static bundle."
    );
  }
  return env.weaviateUrl.replace(/\/$/, "");
}

function headers(extra: HeadersInit = {}): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(extra as Record<string, string>),
  };
  if (env.weaviateApiKey) {
    h.Authorization = `Bearer ${env.weaviateApiKey}`;
  }
  return h;
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUTS_MS.fast;
  return withTimeout(
    async (signal) => {
      const res = await fetch(`${baseUrl()}/v1/graphql`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ query, variables }),
        signal,
      });
      if (!res.ok) {
        throw new Error(
          `Weaviate GraphQL ${res.status} ${res.statusText}: ${await res.text()}`
        );
      }
      const payload = (await res.json()) as {
        data?: T;
        errors?: Array<{ message: string }>;
      };
      if (payload.errors && payload.errors.length > 0) {
        throw new Error(
          `Weaviate GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`
        );
      }
      if (!payload.data) {
        throw new Error("Weaviate GraphQL returned no data");
      }
      return payload.data;
    },
    timeoutMs,
    "Weaviate GraphQL",
  );
}

export async function restGet<T>(
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUTS_MS.fast;
  return withTimeout(
    async (signal) => {
      const res = await fetch(`${baseUrl()}${path}`, { headers: headers(), signal });
      if (!res.ok) {
        throw new Error(
          `Weaviate REST ${res.status} ${res.statusText}: ${await res.text()}`
        );
      }
      return (await res.json()) as T;
    },
    timeoutMs,
    `Weaviate REST ${path}`,
  );
}
