import { handle, badRequest } from "@/lib/server-respond";
import { fetchTestHistory } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const suite = params.get("suite");
  const name = params.get("name");
  const version = params.get("version") ?? undefined;
  if (!suite || !name) {
    return badRequest("Both 'suite' and 'name' query params are required.");
  }
  return handle(() => fetchTestHistory(suite, name, version));
}
