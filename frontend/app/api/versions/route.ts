import { handle } from "@/lib/server-respond";
import { fetchVersionRollup } from "@/lib/weaviate/queries.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handle(() => fetchVersionRollup());
}
