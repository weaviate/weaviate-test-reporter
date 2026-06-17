import { handle, parseFiniteInt } from "@/lib/server-respond";
import { fetchFlakyTests } from "@/lib/weaviate/queries.server";
import type { FlakesWindow } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const window: FlakesWindow = sp.get("window") === "30d" ? "30d" : "7d";
  const minRuns = parseFiniteInt(sp.get("minRuns"));
  return handle(() => fetchFlakyTests(window, { minRuns }));
}
