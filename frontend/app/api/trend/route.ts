import { handle, badRequest, repositoryParam } from "@/lib/server-respond";
import { fetchRunTrend } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const repository = repositoryParam(params);
  if (repository instanceof Response) return repository;
  const sinceRaw = params.get("since") ?? undefined;
  if (sinceRaw !== undefined && Number.isNaN(new Date(sinceRaw).getTime())) {
    return badRequest(
      "Invalid 'since' parameter; could not be parsed as a timestamp.",
    );
  }
  const filters = {
    branches: params.getAll("branch"),
    versionMinors: params.getAll("versionMinor"),
  };
  return handle(() => fetchRunTrend(repository, sinceRaw, filters));
}
