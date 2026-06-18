import { CloudOff } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { AgentChat } from "@/components/AgentChat";
import { getAgentAvailable } from "@/lib/server-env";

// Server-rendered per request so availability reflects the runtime cluster.
export const dynamic = "force-dynamic";

/**
 * "Ask your tests" — Weaviate Query Agent chatbot.
 *
 * The Agent is a Weaviate Cloud-only service (api.agents.weaviate.io).
 * The Sidebar already hides this nav entry on non-WCD deployments; if
 * the user lands here by URL we render a friendly "not available"
 * state instead of letting the agent fetch fail.
 *
 * `getAgentAvailable()` reads the server-only WEAVIATE_URL at request time,
 * so the cluster URL never reaches the browser.
 */
export default function AgentPage() {
  const available = getAgentAvailable();

  return (
    <>
      <PageHeader
        eyebrow="Ask your tests"
        title="Query Agent"
        description="Natural-language Q&A over your TestRun + TestCase history, powered by the Weaviate Query Agent. The agent picks the right collection, runs the searches it needs, and cites the rows it used."
      />

      <section className="px-8 py-8">
        {available ? (
          <AgentChat />
        ) : (
          <EmptyState
            Icon={CloudOff}
            title="Query Agent requires a Weaviate Cloud instance"
            description="The Agent runs on api.agents.weaviate.io and is exclusive to Weaviate Cloud. Point WEAVIATE_URL at a `*.weaviate.cloud` cluster (with a read-only API key, configured server-side) to enable this tab."
          />
        )}
      </section>
    </>
  );
}
