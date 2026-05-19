"use client";

import { useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { AgentMessage, type StoredMessage } from "./AgentMessage";
import {
  QueryAgentError,
  streamAskAgent,
  type ChatMessage,
} from "@/lib/queryAgent";

const EXAMPLE_PROMPTS = [
  "Which tests have failed most often in the last 50 runs?",
  "Summarise the top failure types for Weaviate 1.37.",
  "Find runs that took more than 30 minutes — what suite was slowest?",
  "Are there any tests that pass on 1.37 but fail on 1.36?",
];

/**
 * Chatbot interface for the Weaviate Query Agent.
 *
 * Multi-turn: the component stores the full message history and replays
 * it to the agent on every turn (the agent has no server-side memory).
 *
 * Streaming: progress and tokens render incrementally so the user sees
 * activity during the typical 5–15s response time. Only one in-flight
 * request at a time (the input + send button are disabled until the
 * stream closes or the user cancels via the Stop button).
 */
export function AgentChat() {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  function updateLastAssistant(
    updater: (prev: Extract<StoredMessage, { kind: "assistant" }>) => Extract<
      StoredMessage,
      { kind: "assistant" }
    >,
  ) {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m.kind === "assistant") {
          next[i] = updater(m);
          break;
        }
      }
      return next;
    });
    scrollToBottom();
  }

  async function send(text: string) {
    if (busy) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // History to send to the agent = every prior turn, in role order.
    // Skip ephemeral fields (progress/error/final) — the agent only
    // cares about role + content. Assistant final answers go in as the
    // assistant's prior reply.
    const history: ChatMessage[] = messages
      .map<ChatMessage | null>((m) => {
        if (m.kind === "user") return { role: "user", content: m.content };
        const content = m.final?.final_answer ?? m.content;
        if (!content) return null;
        return { role: "assistant", content };
      })
      .filter((m): m is ChatMessage => m !== null);

    setMessages((prev) => [
      ...prev,
      { kind: "user", role: "user", content: trimmed },
      { kind: "assistant", content: "" },
    ]);
    setInput("");
    setBusy(true);
    scrollToBottom();

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await streamAskAgent(
        trimmed,
        {
          onProgress: (p) =>
            updateLastAssistant((prev) => ({ ...prev, progress: p.message })),
          onTokens: (t) =>
            updateLastAssistant((prev) => ({
              ...prev,
              content: prev.content + t.delta,
            })),
          onFinal: (a) =>
            updateLastAssistant((prev) => ({
              ...prev,
              final: a,
              progress: undefined,
            })),
          onError: (e) =>
            updateLastAssistant((prev) => ({ ...prev, error: e.message })),
        },
        { history, signal: ctrl.signal },
      );
    } catch (e) {
      if (ctrl.signal.aborted) {
        updateLastAssistant((prev) => ({
          ...prev,
          error: "Stopped by user.",
        }));
      } else {
        const msg =
          e instanceof QueryAgentError
            ? `${e.message}${e.detail ? ` — ${e.detail}` : ""}`
            : e instanceof Error
              ? e.message
              : String(e);
        updateLastAssistant((prev) => ({ ...prev, error: msg }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-200px)] min-h-[480px] max-w-4xl">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-4 pr-2"
        data-testid="agent-chat-scroll"
      >
        {messages.length === 0 ? (
          <ExampleStarter onPick={(p) => void send(p)} />
        ) : (
          messages.map((m, i) => <AgentMessage key={i} msg={m} />)
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="mt-4 flex items-end gap-2"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Ask anything about your test history…"
          disabled={busy}
          aria-label="Ask the Query Agent"
          data-testid="agent-chat-input"
          className="
            flex-1 resize-none rounded-md border border-wv-navy-3/60
            bg-wv-navy-2/40 px-3 py-2 text-sm text-wv-fog
            placeholder:text-wv-fog-muted/60 outline-none
            focus:border-wv-green/60 disabled:opacity-50
          "
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            data-testid="agent-chat-stop"
            className="
              shrink-0 inline-flex items-center justify-center gap-2
              h-12 px-4 rounded-md
              border border-wv-danger/40 text-wv-danger
              hover:bg-wv-danger/10 transition-colors
            "
            aria-label="Stop"
          >
            <Square size={14} strokeWidth={1.75} fill="currentColor" />
            <span className="text-sm">Stop</span>
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            data-testid="agent-chat-send"
            className="
              shrink-0 inline-flex items-center justify-center gap-2
              h-12 px-4 rounded-md
              bg-wv-green/15 border border-wv-green/40 text-wv-green
              hover:bg-wv-green/25 transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
            "
            aria-label="Send"
          >
            <Send size={14} strokeWidth={1.75} />
            <span className="text-sm">Send</span>
          </button>
        )}
      </form>
    </div>
  );
}

function ExampleStarter({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div
      className="rounded-lg border border-wv-navy-3/40 bg-wv-navy-2/30 p-6"
      data-testid="agent-example-starter"
    >
      <p className="text-sm text-wv-fog-muted leading-relaxed">
        The Query Agent reads your test history straight from Weaviate and
        answers in plain English. It picks the right collection, runs the
        searches it needs, and cites the rows it used.
      </p>
      <p className="mt-4 text-[11px] uppercase tracking-[0.18em] font-mono text-wv-fog-muted">
        Try one of these
      </p>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onPick(p)}
              className="
                w-full text-left text-sm text-wv-fog
                rounded-md border border-wv-navy-3/40 bg-wv-navy/40 px-3 py-2.5
                hover:border-wv-green/40 hover:bg-wv-navy/60
                transition-colors
              "
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
