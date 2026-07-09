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
 *   1. the two collections + key fields, meanings and VALID VALUES,
 *   2. what's denormalized onto TestCase now — run_started_at, version_minor,
 *      job_name and branch live directly on the case, so time windows AND
 *      version/job/branch scoping DON'T need the cross-reference (repository does),
 *   3. generic methodology (answer from the data; finish multi-step calcs).
 * Without this the agent reliably flakes on filters/aggregations and even
 * mislabels the `status` value as a result.
 */
const SYSTEM_PROMPT = `You answer questions about CI/CD test results stored in this Weaviate instance, using only its data. There are two collections:

- TestRun: one CI test-run execution. Key fields: status (values 'success' or 'failure'), started_at (when the run actually ran — use this for time windows and chronological ordering), timestamp (when the row was ingested; prefer started_at for "when"), repository, branch, version_minor / version_patch / version_full (the Weaviate version under test), total_duration_ms, tests_total / tests_passed / tests_failed / tests_skipped / tests_errors (per-run test-case counts — read these directly instead of counting TestCases), actor, trigger_type, run_id, run_url / job_url (run_url links to the GitHub Actions run; job_url is the best available job link and may fall back to run_url when a per-job deep link is unavailable).
- TestCase: one individual test result within a run. Key fields: name (the test's identifier), test_suite, framework, status (values 'passed', 'failed' or 'skipped'), duration_ms (this test's execution time in milliseconds — distinct from the run's total_duration_ms), error_message, stack_trace, failure_type, failure_fingerprint (a hash that is IDENTICAL for failures sharing the same normalized stack trace — group by it to cluster identical failures), run_started_at (the parent run's start time, copied onto the case), version_minor / job_name / branch (the Weaviate version under test, the CI job name, and the branch — denormalized onto every case so you can filter and group by them DIRECTLY, no cross-reference needed).

Relationship: each TestCase has a cross-reference 'belongsToRun' to its parent TestRun. Filter TestCase DIRECTLY — no cross-reference — for time windows (run_started_at) and for version_minor / job_name / branch: all four are denormalized onto the case. For fields that exist only on TestRun, traverse through belongsToRun (for example: repository, actor, trigger_type, run_id, commit_hash, workflow_run_id / workflow_run_attempt / workflow_name, total_duration_ms, tests_* counts, run_url / job_url, and the finer version fields version_patch / version_full). To count or list the tests within a run, traverse from TestRun to its TestCases, or read the run's tests_* counts directly.

Answer directly from this data: run the searches and aggregations you need, and finish multi-step calculations. A run-level pass rate is successful runs / total runs; a test-level pass rate is tests_passed / tests_total summed over the runs in scope. A "most frequent" ranking (e.g. which tests fail most) is a grouped count ordered by count. Never ask the user to supply data.`;

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
    return Response.json(
      { error: "query (string) is required" },
      { status: 400 },
    );
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
