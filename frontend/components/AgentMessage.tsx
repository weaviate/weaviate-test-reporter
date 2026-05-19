"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Search,
  User2,
  Wand2,
} from "lucide-react";
import type {
  AgentAnswer,
  AgentSearch,
  ChatMessage as RoleMessage,
} from "@/lib/queryAgent";

/**
 * Stored message shape. User messages carry only role + content;
 * assistant messages also carry the streaming progress + the final
 * structured answer once it lands.
 */
export type StoredMessage =
  | (RoleMessage & { kind: "user" })
  | {
      kind: "assistant";
      /** Streamed token buffer — final answer arrives in `final.final_answer`
       *  via `final_state`, but until then we render the accumulating text. */
      content: string;
      /** Progress line from the most recent `progress_message` event. */
      progress?: string;
      /** Populated when the agent emits `final_state`. */
      final?: AgentAnswer;
      /** Populated when something goes wrong mid-stream. */
      error?: string;
    };

export function AgentMessage({ msg }: { msg: StoredMessage }) {
  if (msg.kind === "user") {
    return (
      <article
        className="flex items-start gap-3 justify-end wv-reveal"
        data-testid="agent-message-user"
      >
        <div
          className="
            max-w-[75%] rounded-lg px-4 py-2.5
            bg-wv-green/10 border border-wv-green/30
            text-wv-fog text-sm leading-relaxed
          "
        >
          {msg.content}
        </div>
        <span
          aria-hidden="true"
          className="shrink-0 mt-0.5 w-7 h-7 rounded-full bg-wv-navy-3/60 flex items-center justify-center"
        >
          <User2 size={14} strokeWidth={1.75} className="text-wv-fog-muted" />
        </span>
      </article>
    );
  }

  // Assistant.
  return (
    <article
      className="flex items-start gap-3 wv-reveal"
      data-testid="agent-message-assistant"
    >
      <span
        aria-hidden="true"
        className="shrink-0 mt-0.5 w-7 h-7 rounded-full bg-wv-green/10 border border-wv-green/30 flex items-center justify-center"
      >
        <Wand2 size={14} strokeWidth={1.75} className="text-wv-green" />
      </span>
      <div className="max-w-[80%] flex-1">
        <div
          className="
            rounded-lg px-4 py-2.5
            bg-wv-navy-2/60 border border-wv-navy-3/60
            text-wv-fog text-sm leading-relaxed whitespace-pre-wrap
          "
        >
          {msg.final ? msg.final.final_answer : msg.content || (
            <span className="text-wv-fog-muted italic">
              {msg.progress ?? "Thinking…"}
            </span>
          )}
        </div>

        {msg.error ? (
          <p
            className="mt-2 flex items-center gap-1.5 text-xs text-wv-danger"
            data-testid="agent-message-error"
          >
            <CircleAlert size={13} strokeWidth={1.75} />
            {msg.error}
          </p>
        ) : null}

        {msg.final?.sources?.length ? <Sources sources={msg.final.sources} /> : null}

        {msg.final?.searches?.length ? (
          <SearchesDetail searches={msg.final.searches} />
        ) : null}

        {msg.final?.usage ? (
          <p className="mt-2 text-[11px] font-mono text-wv-fog-muted/80">
            {msg.final.usage.remaining_plan_requests.toLocaleString()} agent
            requests left this month · {Math.round(msg.final.total_time)}s
          </p>
        ) : null}
      </div>
    </article>
  );
}

function Sources({ sources }: { sources: NonNullable<AgentAnswer["sources"]> }) {
  // Group by collection so multiple sources from the same collection
  // share a header — keeps the chip strip readable when the agent
  // pulls 10+ rows.
  const byCollection = new Map<string, string[]>();
  for (const s of sources) {
    const list = byCollection.get(s.collection) ?? [];
    list.push(s.object_id);
    byCollection.set(s.collection, list);
  }
  return (
    <div
      className="mt-2 space-y-1.5"
      data-testid="agent-message-sources"
    >
      {[...byCollection.entries()].map(([collection, ids]) => (
        <div key={collection} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.18em] font-mono text-wv-fog-muted">
            {collection}
          </span>
          {ids.map((id) => {
            const href =
              collection === "TestRun" ? `/?run=${encodeURIComponent(id)}` : null;
            const label = id.slice(0, 8);
            const className =
              "inline-flex items-center gap-1 px-2 py-0.5 rounded " +
              "text-[11px] font-mono " +
              "bg-wv-navy-3/40 border border-wv-navy-3/60 " +
              "text-wv-fog-muted hover:text-wv-fog hover:bg-wv-navy-3/60 " +
              "transition-colors";
            return href ? (
              <a key={id} href={href} className={className} title={id}>
                {label}
                <ExternalLink size={10} strokeWidth={1.75} />
              </a>
            ) : (
              <span key={id} className={className} title={id}>
                {label}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SearchesDetail({ searches }: { searches: AgentSearch[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2" data-testid="agent-message-searches">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="
          inline-flex items-center gap-1 text-[11px] font-mono
          text-wv-fog-muted hover:text-wv-fog
        "
      >
        {open ? (
          <ChevronDown size={11} strokeWidth={1.75} />
        ) : (
          <ChevronRight size={11} strokeWidth={1.75} />
        )}
        <Search size={11} strokeWidth={1.75} />
        {searches.length} search{searches.length === 1 ? "" : "es"} the agent ran
      </button>
      {open ? (
        <ul className="mt-2 space-y-1.5">
          {searches.map((s, i) => (
            <li
              key={i}
              className="
                rounded-md border border-wv-navy-3/40 bg-wv-navy/40 px-3 py-2
                font-mono text-[11px] leading-relaxed
              "
            >
              <p className="text-wv-fog">
                <span className="text-wv-fog-muted">collection:</span>{" "}
                {s.collection}
              </p>
              {s.queries?.length ? (
                <p className="text-wv-fog-muted mt-0.5">
                  queries: <span className="text-wv-fog">{s.queries.join(", ")}</span>
                </p>
              ) : null}
              {s.filter_operators ? (
                <p className="text-wv-fog-muted mt-0.5">
                  filter ops: <span className="text-wv-fog">{s.filter_operators}</span>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
