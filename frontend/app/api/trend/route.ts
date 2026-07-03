import { handle, badRequest } from "@/lib/server-respond";
import { fetchRunTrend } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sinceRaw = new URL(req.url).searchParams.get("since") ?? undefined;
  if (sinceRaw !== undefined && Number.isNaN(new Date(sinceRaw).getTime())) {
    return badRequest(
      "Invalid 'since' parameter; expected an ISO 8601 timestamp.",
    );
  }
  return handle(() => fetchRunTrend(sinceRaw));
}
