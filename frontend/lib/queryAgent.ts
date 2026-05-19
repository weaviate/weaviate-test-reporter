/**
 * Browser-side client for the Weaviate Query Agent.
 *
 * The official `weaviate-agents` npm package can't bundle for the
 * browser — it depends on `weaviate-client` v3 which pulls in
 * `@grpc/grpc-js` and `node:http2`. We hit the agent's HTTP API
 * directly instead.
 *
 * CORS notes (verified empirically against api.agents.weaviate.io):
 *   - Preflight allows: `content-type`, `authorization`,
 *     `x-weaviate-cluster-url`
 *   - It DOES NOT allow `x-agent-request-origin`; sending that header
 *     causes preflight to fail. The SDK uses it for telemetry only, so
 *     omitting it is safe.
 *
 * Auth shape: `Authorization: Bearer <api-key>`. The SDK source uses a
 * variable called `bearerToken` whose value is already the full
 * `Bearer ...` string — easy to read as "raw token", but the agent
 * service responds 401 with
 *   {"detail":"... using Bearer auth (i.e. Authorization: Bearer YOUR_KEY)."}
 * if you skip the prefix.
 *
 * Endpoint: POST https://api.agents.weaviate.io/query/ask (single-shot)
 *           POST https://api.agents.weaviate.io/query/stream_ask (SSE)
 *
 * The agent is a separate hosted service; the cluster URL is forwarded
 * via `X-Weaviate-Cluster-Url` so it knows which Weaviate to query.
 */
import { env, agentAvailable } from "./env";

const AGENT_BASE_URL = "https://api.agents.weaviate.io";

export type AgentSource = {
  /** UUID of the matching object. */
  object_id: string;
  /** Collection name the source belongs to. */
  collection: string;
};

export type AgentSearch = {
  collection: string;
  queries?: string[];
  filters?: unknown[];
  filter_operators?: string;
};

export type AgentAggregation = {
  collection: string;
  /** Free-form — agent returns its aggregation plan as a structured tree. */
  [key: string]: unknown;
};

export type AgentUsage = {
  model_units: number;
  usage_in_plan: boolean;
  remaining_plan_requests: number;
};

/** Final agent answer, as returned by `/query/ask` (or `final_state` in SSE). */
export type AgentAnswer = {
  final_answer: string;
  searches: AgentSearch[];
  aggregations: AgentAggregation[];
  sources?: AgentSource[];
  missing_information?: string[];
  is_partial_answer?: boolean;
  usage: AgentUsage;
  total_time: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AskOptions = {
  /** Multi-turn history; the agent has no server-side memory, so the caller
   *  must replay prior messages on every turn. The current question goes
   *  into `query`, NOT into the history. */
  history?: ChatMessage[];
  /** Limit which TestRun/TestCase collections the agent searches. */
  collections?: string[];
  /** Aborts the in-flight fetch. */
  signal?: AbortSignal;
};

export class QueryAgentError extends Error {
  constructor(
    message: string,
    public status?: number,
    public detail?: string,
  ) {
    super(message);
    this.name = "QueryAgentError";
  }
}

function ensureAvailable(): void {
  if (!agentAvailable()) {
    throw new QueryAgentError(
      "Query Agent requires a Weaviate Cloud instance — configure " +
        "NEXT_PUBLIC_WEAVIATE_URL to a *.weaviate.cloud cluster.",
    );
  }
  if (!env.weaviateApiKey) {
    throw new QueryAgentError(
      "Query Agent requires NEXT_PUBLIC_WEAVIATE_API_KEY (read-only key " +
        "is fine — the agent forwards it to your cluster).",
    );
  }
}

function headers(): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.weaviateApiKey}`,
    "X-Weaviate-Cluster-Url": env.weaviateUrl.replace(/\/$/, ""),
  };
}

function buildBody(query: string, opts: AskOptions = {}): string {
  // Multi-turn: send `{messages: [...]}` shape where the trailing user
  // message is the current question. Single-shot: just the bare string.
  const askPayload: string | { messages: ChatMessage[] } = opts.history?.length
    ? {
        messages: [
          ...opts.history,
          { role: "user", content: query },
        ],
      }
    : query;
  return JSON.stringify({
    // `headers` here are vectorizer / inference-provider keys forwarded
    // by the agent to the user's cluster (X-OpenAI-Api-Key, etc.). The
    // dashboard doesn't need any of them — `text2vec-weaviate` is
    // wired server-side on WCD.
    headers: {},
    query: askPayload,
    collections: opts.collections ?? ["TestRun", "TestCase"],
    system_prompt: undefined,
    result_evaluation: "none",
  });
}

/** Single-shot `ask` — returns the full answer at once. Use for testing
 *  or contexts where streaming UX isn't needed. ~5–15s latency is normal. */
export async function askAgent(
  query: string,
  opts: AskOptions = {},
): Promise<AgentAnswer> {
  ensureAvailable();
  const res = await fetch(`${AGENT_BASE_URL}/query/ask`, {
    method: "POST",
    headers: headers(),
    body: buildBody(query, opts),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new QueryAgentError(
      `Query Agent returned ${res.status} ${res.statusText}`,
      res.status,
      text,
    );
  }
  return (await res.json()) as AgentAnswer;
}

// ---------- SSE streaming ----------

export type AgentStreamProgress = {
  /** Short status string the agent emits as it works ("searching TestRun…",
   *  "running aggregation…"). Surfacing this in the UI explains the
   *  10-second wait. */
  message: string;
};

export type AgentStreamTokens = {
  /** Incremental token chunk to append to the assistant's answer. */
  delta: string;
};

export type StreamAskCallbacks = {
  /** Fired on every `progress_message` SSE event. */
  onProgress?: (p: AgentStreamProgress) => void;
  /** Fired on every `streamed_tokens` SSE event — UI appends `delta` to the
   *  current assistant message. */
  onTokens?: (t: AgentStreamTokens) => void;
  /** Fired exactly once when the agent sends `final_state` — the complete
   *  AgentAnswer (sources, searches, usage, etc.). */
  onFinal?: (a: AgentAnswer) => void;
  /** Fired on any `error` SSE event or non-SSE failure. */
  onError?: (e: Error) => void;
};

/**
 * Streaming variant. Returns a promise that resolves when the stream is
 * closed cleanly (after `onFinal`) or rejects on transport error.
 *
 * SSE format (per `weaviate-agents` source):
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * Multi-line `data:` is joined with `\n`. Unknown event types are
 * ignored rather than throwing — keeps the UI resilient if the server
 * adds new event types later.
 */
export async function streamAskAgent(
  query: string,
  callbacks: StreamAskCallbacks,
  opts: AskOptions = {},
): Promise<void> {
  ensureAvailable();
  const body = JSON.stringify({
    ...JSON.parse(buildBody(query, opts)),
    include_progress: true,
    include_final_state: true,
  });
  const res = await fetch(`${AGENT_BASE_URL}/query/stream_ask`, {
    method: "POST",
    headers: { ...headers(), Accept: "text/event-stream" },
    body,
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new QueryAgentError(
      `Query Agent returned ${res.status} ${res.statusText}`,
      res.status,
      text,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are blank-line delimited. Loop because a single
      // chunk can contain multiple full events.
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        dispatchEvent(rawEvent, callbacks);
      }
    }
    // Flush a trailing partial event if any (shouldn't happen on a
    // well-behaved server, but harmless to attempt).
    if (buffer.trim()) dispatchEvent(buffer, callbacks);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function dispatchEvent(raw: string, callbacks: StreamAskCallbacks): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    // Other SSE field types (`id:`, `retry:`, comments) ignored.
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");

  try {
    switch (event) {
      case "progress_message": {
        const parsed = JSON.parse(data) as AgentStreamProgress;
        callbacks.onProgress?.(parsed);
        return;
      }
      case "streamed_tokens": {
        const parsed = JSON.parse(data) as AgentStreamTokens;
        callbacks.onTokens?.(parsed);
        return;
      }
      case "final_state": {
        const parsed = JSON.parse(data) as AgentAnswer;
        callbacks.onFinal?.(parsed);
        return;
      }
      case "error": {
        callbacks.onError?.(new QueryAgentError(`Agent error: ${data}`));
        return;
      }
      default:
        // Unknown event: ignore. Forward-compat with new event types.
        return;
    }
  } catch (e) {
    callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
  }
}
