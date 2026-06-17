import { handle } from "@/lib/server-respond";
import { fetchRecentRuns } from "@/lib/weaviate/queries.server";
import { RECENT_RUNS_LIMIT } from "@/lib/constants";
import type { RunFilters } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const filters: RunFilters = {
    search: sp.get("search") ?? undefined,
    repositories: sp.getAll("repository"),
    statuses: sp.getAll("status"),
    versionMinors: sp.getAll("versionMinor"),
    versionFulls: sp.getAll("versionFull"),
  };
  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Number(limitRaw) : RECENT_RUNS_LIMIT;
  return handle(() => fetchRecentRuns(filters, limit));
}
