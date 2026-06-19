import { serverEnv, getAgentAvailable } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_BASE_URL = "https://api.agents.weaviate.io";

type ChatMessage = { role: "user" | "assistant"; content: string };

/** Default the agent searches: TestRun bare, TestCase across all three named
 *  vectors (broad recall for open-ended chat prompts). */
const DEFAULT_COLLECTIONS = [
  "TestRun",
  { name: "TestCase", target_vector: ["stack_trace", "error_message", "name"] },
];

/**
 * Generic orientation for the Query Agent. It is deliberately NOT a per-query
 * playbook (no "if asked X, do Y") — that wouldn't scale. It gives the agent:
 *   1. the two collections + each field's meaning and VALID VALUES,
 *   2. the belongsToRun cross-reference and how to correlate across it
 *      (TestCase has no date/version/branch of its own — those live on the
 *      run), and
 *   3. generic methodology (answer from the data; finish multi-step calcs).
 * Without this the agent reliably flakes on filters/aggregations and even
 * mislabels the `status` value as a result.
 */
const SYSTEM_PROMPT = `You answer questions about CI/CD test results stored in this Weaviate instance, using only its data. There are two collections:

- TestRun: one CI test-run execution. Fields: status (values 'success' or 'failure'), timestamp (when the run ran), repository, branch, version_minor / version_patch / version_full (the Weaviate version under test), total_duration_ms, actor, trigger_type, run_id.
- TestCase: one individual test result within a run. Fields: name (the test's identifier), test_suite, framework, status (values 'passed', 'failed' or 'skipped'), error_message, stack_trace, failure_type.

Relationship: each TestCase has a cross-reference 'belongsToRun' pointing to its parent TestRun. TestCase has NO date, version, branch or repository fields of its own — those live on the TestRun. To scope or group test cases by a run-level attribute (a time window via the run's timestamp, or by version_minor / version_patch / branch / repository), filter or aggregate TestCase through its belongsToRun reference to TestRun. Conversely, to count or list the tests within a run, traverse from TestRun to its TestCases.

Answer directly from this data: run the searches and aggregations you need, and finish multi-step calculations (a pass rate is successful runs divided by total runs; a 'most frequent' ranking is a grouped count ordered by count). Never ask the user to supply data.`;

/**
 * Server-side proxy to the Weaviate Query Agent (Cloud-only). The browser
 * POSTs `{ query, history?, collections? }`; we attach the server-held key +
 * cluster URL and stream the SSE response straight back. This keeps the key
 * off the client entirely (the old browser path embedded it).
 */
export async function POST(req: Request): Promise<Response> {
  if (!getAgentAvailable()) {
    return Response.json(
      {
        error:
          "Query Agent requires a Weaviate Cloud cluster with an API key " +
          "configured server-side (WEAVIATE_URL + WEAVIATE_API_KEY).",
      },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    query?: string;
    history?: ChatMessage[];
  } | null;
  if (!body || typeof body.query !== "string" || !body.query.trim()) {
    return Response.json({ error: "query (string) is required" }, { status: 400 });
  }

  // Multi-turn: trailing user message is the current question. Single-shot:
  // bare string. (The agent has no server-side memory; the client replays
  // history each turn.)
  const askPayload: string | { messages: ChatMessage[] } = body.history?.length
    ? { messages: [...body.history, { role: "user", content: body.query }] }
    : body.query;

  const upstream = await fetch(`${AGENT_BASE_URL}/query/stream_ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${serverEnv.weaviateApiKey}`,
      "X-Weaviate-Cluster-Url": serverEnv.weaviateUrl.replace(/\/$/, ""),
    },
    body: JSON.stringify({
      headers: {},
      query: askPayload,
      collections: DEFAULT_COLLECTIONS,
      system_prompt: SYSTEM_PROMPT,
      result_evaluation: "none",
      include_progress: true,
      include_final_state: true,
    }),
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      {
        error: `Query Agent returned ${upstream.status} ${upstream.statusText}`,
        detail,
      },
      { status: upstream.status || 502 },
    );
  }

  // Pipe the upstream SSE bytes straight through to the browser.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
