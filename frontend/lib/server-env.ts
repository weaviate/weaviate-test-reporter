import "server-only";

/**
 * Server-only Weaviate connection settings.
 *
 * Unlike the pre-migration `NEXT_PUBLIC_*` vars (which were inlined into the
 * static bundle and therefore visible to every browser), these are read at
 * RUNTIME on the server and NEVER shipped to the client. The dashboard talks
 * to Weaviate exclusively through the server-side `/api/*` route handlers, so
 * the cluster URL and (read-only) key stay on the server.
 *
 * The `import "server-only"` guard makes the build fail loudly if any of this
 * is ever imported into a Client Component by mistake.
 */
export const serverEnv = {
  weaviateUrl: process.env.WEAVIATE_URL ?? "",
  weaviateApiKey: process.env.WEAVIATE_API_KEY ?? "",
  /** Optional gRPC overrides for self-hosted clusters whose gRPC endpoint
   *  isn't the conventional `<httpHost>:50051`. Ignored for Weaviate Cloud. */
  grpcHost: process.env.WEAVIATE_GRPC_HOST ?? "",
  grpcPort: process.env.WEAVIATE_GRPC_PORT ?? "",
};

export function serverEnvIsConfigured(): boolean {
  return Boolean(serverEnv.weaviateUrl);
}

/**
 * True when the configured cluster URL looks like a Weaviate Cloud host.
 * The Query Agent (api.agents.weaviate.io) is Cloud-only, so this gates the
 * Agent tab. Falls back to `false` on malformed URLs.
 */
export function isWeaviateCloudUrl(url: string = serverEnv.weaviateUrl): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith(".weaviate.cloud") || host.endsWith(".weaviate.network")
    );
  } catch {
    return false;
  }
}

/**
 * Agent tab is available only on a configured Weaviate Cloud cluster WITH a
 * key (the agent forwards the key to your cluster). Computed server-side and
 * surfaced to the browser as a bare boolean — the URL never leaves the server.
 */
export function getAgentAvailable(): boolean {
  return (
    serverEnvIsConfigured() &&
    isWeaviateCloudUrl() &&
    Boolean(serverEnv.weaviateApiKey)
  );
}
