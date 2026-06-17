/**
 * Client-side wrapper for the Weaviate Query Agent.
 *
 * The browser no longer calls api.agents.weaviate.io directly — that exposed
 * the cluster URL + key. Instead it POSTs to the same-origin `/api/agent`
 * route handler, which attaches the server-held key and streams the agent's
 * SSE response back. This module keeps the SSE-parsing UX identical; only the
 * transport (now same-origin, no auth headers, simpler body) changed.
 */

const AGENT_ENDPOINT = "/api/agent";

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

/** Final agent answer, as returned by the agent's `final_state` SSE event. */
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

/**
 * A collection the agent can search. Bare string for single-vector
 * collections (e.g. `TestRun`); the object form names which vector(s) to use
 * for a multi-vector collection (`TestCase`). When omitted, the server applies
 * a sensible default (TestRun + TestCase across all three vectors).
 */
export type AgentCollection =
  | string
  | { name: string; target_vector?: string[]; view_properties?: string[] };

export type AskOptions = {
  /** Multi-turn history; the agent has no server-side memory, so the caller
   *  replays prior messages each turn. The current question goes into
   *  `query`, NOT into the history. */
  history?: ChatMessage[];
  /** Limit which collections the agent searches. Omit to use the server
   *  default. */
  collections?: AgentCollection[];
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

function buildBody(query: string, opts: AskOptions): string {
  return JSON.stringify({
    query,
    history: opts.history,
    collections: opts.collections,
  });
}

async function readErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: string; detail?: string };
    // Prefer `detail` — it carries the actionable upstream payload; `error`
    // is usually just the status-line summary already in the thrown message.
    return j?.detail ?? j?.error ?? text;
  } catch {
    return text;
  }
}

/** Single-shot ask — drives the streaming endpoint and resolves with the final
 *  answer. (The UI uses streaming directly; this is kept for completeness.) */
export async function askAgent(
  query: string,
  opts: AskOptions = {},
): Promise<AgentAnswer> {
  let final: AgentAnswer | undefined;
  let streamError: Error | undefined;
  await streamAskAgent(
    query,
    {
      onFinal: (a) => {
        final = a;
      },
      // Capture an `error` SSE event so its cause propagates instead of being
      // masked by the generic "closed without a final answer" below.
      onError: (e) => {
        streamError = e;
      },
    },
    opts,
  );
  if (streamError) throw streamError;
  if (!final) {
    throw new QueryAgentError("Agent stream closed without a final answer");
  }
  return final;
}

// ---------- SSE streaming ----------

export type AgentStreamProgress = {
  /** Short status string the agent emits as it works ("searching TestRun…"). */
  message: string;
};

export type AgentStreamTokens = {
  /** Incremental token chunk to append to the assistant's answer. */
  delta: string;
};

export type StreamAskCallbacks = {
  onProgress?: (p: AgentStreamProgress) => void;
  onTokens?: (t: AgentStreamTokens) => void;
  onFinal?: (a: AgentAnswer) => void;
  onError?: (e: Error) => void;
};

/**
 * Streaming variant. Resolves when the stream closes cleanly (after
 * `onFinal`) or rejects on transport error. SSE events are blank-line
 * delimited; unknown event types are ignored for forward-compat.
 */
export async function streamAskAgent(
  query: string,
  callbacks: StreamAskCallbacks,
  opts: AskOptions = {},
): Promise<void> {
  const res = await fetch(AGENT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: buildBody(query, opts),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const detail = await readErrorDetail(res);
    throw new QueryAgentError(
      `Query Agent returned ${res.status} ${res.statusText}`,
      res.status,
      detail,
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
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        dispatchEvent(rawEvent, callbacks);
      }
    }
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
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");

  try {
    switch (event) {
      case "progress_message": {
        callbacks.onProgress?.(JSON.parse(data) as AgentStreamProgress);
        return;
      }
      case "streamed_tokens": {
        callbacks.onTokens?.(JSON.parse(data) as AgentStreamTokens);
        return;
      }
      case "final_state": {
        callbacks.onFinal?.(JSON.parse(data) as AgentAnswer);
        return;
      }
      case "error": {
        callbacks.onError?.(new QueryAgentError(`Agent error: ${data}`));
        return;
      }
      default:
        return;
    }
  } catch (e) {
    callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
  }
}
