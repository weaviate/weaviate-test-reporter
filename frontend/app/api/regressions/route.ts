import { handle, badRequest, repositoryParam } from "@/lib/server-respond";
import { fetchRegressions } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const repository = repositoryParam(sp);
  if (repository instanceof Response) return repository;
  const daysRaw = sp.get("days");
  let days: number | undefined;
  if (daysRaw !== null) {
    days = Number(daysRaw);
    if (!Number.isFinite(days) || days <= 0) {
      return badRequest("Invalid 'days' parameter; must be a positive number.");
    }
  }
  return handle(() => fetchRegressions(repository, { days }));
}
