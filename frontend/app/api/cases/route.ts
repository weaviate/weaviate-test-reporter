import { handle, badRequest } from "@/lib/server-respond";
import { fetchCasesForRun } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const runUuid = sp.get("runUuid");
  if (!runUuid) return badRequest("runUuid is required");
  const failedOnly = sp.get("failedOnly") === "true";
  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  return handle(() => fetchCasesForRun(runUuid, { failedOnly, limit }));
}
