import { getAgentAvailable } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Non-sensitive client-facing config. The cluster URL/key never leave the
 *  server — only the derived `agentAvailable` boolean is exposed. */
export async function GET(): Promise<Response> {
  return Response.json({ agentAvailable: getAgentAvailable() });
}
