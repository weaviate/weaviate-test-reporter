import { handle, badRequest } from "@/lib/server-respond";
import { fetchRegressions } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const daysRaw = new URL(req.url).searchParams.get("days");
  let days: number | undefined;
  if (daysRaw !== null) {
    days = Number(daysRaw);
    if (!Number.isFinite(days) || days <= 0) {
      return badRequest("Invalid 'days' parameter; must be a positive number.");
    }
  }
  return handle(() => fetchRegressions({ days }));
}
