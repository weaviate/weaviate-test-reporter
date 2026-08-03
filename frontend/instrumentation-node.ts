import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { staleCacheFiles } from "./lib/cache-prune";

/**
 * Server-start sweep of `.next/cache/fetch-cache`. The day-bucketed cache
 * keys (queries.server.ts) strand yesterday's entry files, and Next never
 * deletes them, so a long-lived `.next` (local dev, `next start`) would grow
 * a little every day. Ephemeral hosts start with an empty cache — the sweep
 * is a no-op there. Node-only module: instrumentation.ts imports it behind
 * the NEXT_RUNTIME guard so the edge bundle never sees the node: builtins.
 */
export async function pruneFetchCache(): Promise<void> {
  const dir = join(process.cwd(), ".next", "cache", "fetch-cache");
  try {
    const names = await readdir(dir);
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        mtimeMs: (await stat(join(dir, name))).mtimeMs,
      })),
    );
    const stale = staleCacheFiles(files, Date.now());
    await Promise.all(
      stale.map((name) => unlink(join(dir, name)).catch(() => {})),
    );
    if (stale.length > 0) {
      console.log(`[cache-prune] removed ${stale.length} stale cache entries`);
    }
  } catch {
    // Cache dir absent (fresh build/instance) — nothing to prune.
  }
}
