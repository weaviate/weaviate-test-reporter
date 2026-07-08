import { handle, badRequest } from "@/lib/server-respond";
import { semanticSearch } from "@/lib/weaviate/queries.server";
import {
  TARGET_VECTORS,
  DEFAULT_TARGET_VECTOR,
  type TargetVector,
} from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST (not GET) so long error/stack-trace queries aren't constrained by URL
// length limits.
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    query?: unknown;
    limit?: unknown;
    failedOnly?: unknown;
    targetVector?: unknown;
  } | null;
  if (!body || typeof body.query !== "string") {
    return badRequest("query (string) is required");
  }
  const targetVector: TargetVector = (
    TARGET_VECTORS as readonly string[]
  ).includes(body.targetVector as string)
    ? (body.targetVector as TargetVector)
    : DEFAULT_TARGET_VECTOR;
  const limit = Number.isFinite(body.limit as number)
    ? (body.limit as number)
    : undefined;
  const failedOnly = Boolean(body.failedOnly);
  return handle(
    () =>
      semanticSearch(body.query as string, { limit, failedOnly, targetVector }),
    req,
  );
}
