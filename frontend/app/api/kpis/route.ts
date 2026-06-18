import { handle } from "@/lib/server-respond";
import { fetchDashboardKpis } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sinceRaw = new URL(req.url).searchParams.get("since") ?? undefined;
  if (sinceRaw !== undefined) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return Response.json(
        { error: "Invalid 'since' parameter; expected an ISO 8601 timestamp." },
        { status: 400 },
      );
    }
  }
  return handle(() => fetchDashboardKpis(sinceRaw));
}
