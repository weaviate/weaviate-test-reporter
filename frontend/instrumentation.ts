/**
 * Runtime split: the fs-based cache sweep lives in instrumentation-node.ts,
 * loaded only under the nodejs runtime — the edge bundler statically rejects
 * `node:` builtins in this file even behind a runtime check.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { pruneFetchCache } = await import("./instrumentation-node");
    await pruneFetchCache();
  }
}
