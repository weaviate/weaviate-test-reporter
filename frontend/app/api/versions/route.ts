import { handle, repositoryParam } from "@/lib/server-respond";
import { fetchVersionRollup } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const repository = repositoryParam(sp);
  if (repository instanceof Response) return repository;
  return handle(() => fetchVersionRollup(repository));
}
