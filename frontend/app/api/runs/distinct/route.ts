import { handle, badRequest } from "@/lib/server-respond";
import { fetchDistinctRunValues } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = [
  "repository",
  "branch",
  "actor",
  "status",
  "version_full",
  "version_minor",
] as const;
type Allowed = (typeof ALLOWED)[number];

export async function GET(req: Request): Promise<Response> {
  const property = new URL(req.url).searchParams.get("property") ?? "";
  if (!(ALLOWED as readonly string[]).includes(property)) {
    return badRequest(
      `Unknown property "${property}". Allowed: ${ALLOWED.join(", ")}`,
    );
  }
  return handle(() => fetchDistinctRunValues(property as Allowed));
}
