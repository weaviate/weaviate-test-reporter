import "server-only";
import weaviate, { ApiKey, type WeaviateClient } from "weaviate-client";
import {
  serverEnv,
  serverEnvIsConfigured,
  isWeaviateCloudUrl,
} from "../server-env";

/**
 * Server-side Weaviate client (REST + gRPC) via the official TypeScript
 * client. This replaces the old browser GraphQL layer: the v3 client speaks
 * gRPC over `@grpc/grpc-js` (Node-only), which is exactly why it could not
 * run in the previous static-export SPA but is the right tool here, in the
 * Next.js server.
 *
 * The connection is memoised on `globalThis` so it survives dev HMR reloads
 * (a fresh module instance per edit would otherwise leak gRPC channels) and
 * is reused across route-handler invocations in production.
 */
type ClientCache = { promise?: Promise<WeaviateClient> };
const cache: ClientCache =
  ((globalThis as Record<string, unknown>)
    .__weaviateClientCache as ClientCache) ?? {};
(globalThis as Record<string, unknown>).__weaviateClientCache = cache;

async function connect(): Promise<WeaviateClient> {
  if (!serverEnvIsConfigured()) {
    throw new Error(
      "WEAVIATE_URL is not set. Configure WEAVIATE_URL (and WEAVIATE_API_KEY " +
        "for a Cloud cluster) in the server environment.",
    );
  }
  const url = serverEnv.weaviateUrl;
  const apiKey = serverEnv.weaviateApiKey;

  // text2vec-weaviate (Weaviate Embeddings) needs the cluster URL + key
  // forwarded so `nearText` can vectorize the query server-side on WCD.
  // Only send them when a key is configured (self-hosted model2vec
  // vectorizes in-cluster and needs no such header).
  const headers: Record<string, string> | undefined = apiKey
    ? {
        "X-Weaviate-Cluster-Url": url.replace(/\/$/, ""),
        "X-Weaviate-Api-Key": apiKey,
      }
    : undefined;
  const authCredentials = apiKey ? new ApiKey(apiKey) : undefined;

  // Raise the query timeout (default 30s) to match the client's flakes timeout.
  // The heavy read scans (Flakes/Regressions/Clusters page through up to 200k
  // rows) can exceed 30s on a slow link; a cold query that ABORTS never lands
  // in unstable_cache, so the cache would never warm. Letting it complete once
  // (even slowly) means every subsequent visit is served from cache. Fast paths
  // (prod, co-located with the cluster) finish well under this ceiling.
  const timeout = { init: 15, query: 120, insert: 90 };

  if (isWeaviateCloudUrl(url)) {
    return weaviate.connectToWeaviateCloud(url, {
      authCredentials,
      headers,
      skipInitChecks: true,
      timeout,
    });
  }

  // Self-hosted / local (e.g. http://localhost:8080 in dev + CI). Derive the
  // REST host/port from the URL; gRPC defaults to <host>:50051 unless
  // overridden via WEAVIATE_GRPC_HOST / WEAVIATE_GRPC_PORT.
  const parsed = new URL(url);
  const httpSecure = parsed.protocol === "https:";
  const httpHost = parsed.hostname;
  const httpPort = parsed.port ? Number(parsed.port) : httpSecure ? 443 : 80;
  const grpcHost = serverEnv.grpcHost || httpHost;
  // `serverEnv.grpcPort` defaults to "" when unset; Number("") === 0, so
  // guard for truthiness before parsing to avoid silently using port 0.
  const parsedGrpcPort = serverEnv.grpcPort ? Number(serverEnv.grpcPort) : NaN;
  const grpcPort = Number.isFinite(parsedGrpcPort) ? parsedGrpcPort : 50051;

  return weaviate.connectToCustom({
    httpHost,
    httpPort,
    httpSecure,
    grpcHost,
    grpcPort,
    grpcSecure: httpSecure,
    authCredentials,
    headers,
    skipInitChecks: true,
    timeout,
  });
}

/** Memoised connected client. A failed connect resets the cache so the next
 *  request retries rather than caching a rejected promise forever. */
export function getClient(): Promise<WeaviateClient> {
  if (!cache.promise) {
    cache.promise = connect().catch((err) => {
      cache.promise = undefined;
      throw err;
    });
  }
  return cache.promise;
}
