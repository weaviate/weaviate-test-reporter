import { handle, badRequest, repositoryParam } from "@/lib/server-respond";
import { fetchDistinctRunValues } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The repository list itself is /api/repositories; these are per repository.
const ALLOWED = [
  "branch",
  "actor",
  "status",
  "version_full",
  "version_minor",
] as const;
type Allowed = (typeof ALLOWED)[number];

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const property = sp.get("property") ?? "";
  if (!(ALLOWED as readonly string[]).includes(property)) {
    return badRequest(
      `Unknown property "${property}". Allowed: ${ALLOWED.join(", ")}`,
    );
  }
  const repository = repositoryParam(sp);
  if (repository instanceof Response) return repository;
  return handle(() => fetchDistinctRunValues(repository, property as Allowed));
}
