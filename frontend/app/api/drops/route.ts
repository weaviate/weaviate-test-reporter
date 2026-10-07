import { handle, badRequest, repositoryParam } from "@/lib/server-respond";
import { fetchExecutedDrops } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const repository = repositoryParam(sp);
  if (repository instanceof Response) return repository;
  const sinceRaw = sp.get("since") ?? undefined;
  if (sinceRaw !== undefined && Number.isNaN(new Date(sinceRaw).getTime())) {
    return badRequest(
      "Invalid 'since' parameter; could not be parsed as a timestamp.",
    );
  }
  return handle(() => fetchExecutedDrops(repository, sinceRaw));
}
