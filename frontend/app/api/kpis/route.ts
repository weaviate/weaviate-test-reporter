import { handle, repositoryParam } from "@/lib/server-respond";
import { fetchDashboardKpis } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const repository = repositoryParam(sp);
  if (repository instanceof Response) return repository;
  const sinceRaw = sp.get("since") ?? undefined;
  if (sinceRaw !== undefined) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return Response.json(
        { error: "Invalid 'since' parameter; expected an ISO 8601 timestamp." },
        { status: 400 },
      );
    }
  }
  return handle(() => fetchDashboardKpis(repository, sinceRaw));
}
