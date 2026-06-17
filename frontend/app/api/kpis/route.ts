import { handle } from "@/lib/server-respond";
import { fetchDashboardKpis } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const since = new URL(req.url).searchParams.get("since") ?? undefined;
  return handle(() => fetchDashboardKpis(since));
}
