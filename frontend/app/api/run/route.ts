import { handle, badRequest } from "@/lib/server-respond";
import { fetchRunById } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const uuid = new URL(req.url).searchParams.get("uuid");
  if (!uuid) {
    return badRequest("A run 'uuid' query param is required.");
  }
  return handle(() => fetchRunById(uuid));
}
