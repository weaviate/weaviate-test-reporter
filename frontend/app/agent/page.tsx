"use client";

import { CloudOff } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { AgentChat } from "@/components/AgentChat";
import { agentAvailable } from "@/lib/env";

/**
 * "Ask your tests" — Weaviate Query Agent chatbot.
 *
 * The Agent is a Weaviate Cloud-only service (api.agents.weaviate.io).
 * The Sidebar already hides this nav entry on non-WCD deployments; if
 * the user lands here by URL we render a friendly "not available"
 * state instead of letting the agent fetch fail.
 *
 * `agentAvailable()` reads `process.env.NEXT_PUBLIC_WEAVIATE_URL` which
 * is inlined at build time, so the server-rendered HTML and the client
 * bundle agree — no hydration mismatch.
 */
export default function AgentPage() {
  const available = agentAvailable();

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
            description="The Agent runs on api.agents.weaviate.io and is exclusive to Weaviate Cloud. Point NEXT_PUBLIC_WEAVIATE_URL at a `*.weaviate.cloud` cluster (with a read-only API key) to enable this tab."
          />
        )}
      </section>
    </>
  );
}
