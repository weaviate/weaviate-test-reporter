"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
} from "lucide-react";
import type { ExecutedDrop } from "@/lib/queries";

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const fmtWhen = (iso: string): string =>
  iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—";

/**
 * Expected-vs-executed (WS2 H3): the jobs whose latest run ran fewer tests than
 * the run before. Each row expands in place to a baseline-vs-current comparison
 * (WS-P) — the run that executed the full set vs the run that dropped it, with
 * both CI jobs linked — so a silent collapse is debuggable without guessing what
 * it was compared against. A dumb visual layer; the parent fetches + handles
 * loading/error. Empty list renders a green "all clear" instead.
 */
export function ExecutedDrops({ drops }: { drops: ExecutedDrop[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (drops.length === 0) {
    return (
      <div
        data-testid="executed-drops-clear"
        className="flex items-center gap-3 rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 px-5 py-4 text-[13px] text-wv-fog-muted"
      >
        <CheckCircle2 size={16} className="text-wv-green shrink-0" />
        No job ran fewer tests than its previous run in this window.
      </div>
    );
  }

  return (
    <div
      data-testid="executed-drops"
      className="rounded-lg border border-wv-danger/30 bg-wv-navy-2/40 overflow-hidden"
    >
      {drops.map((d) => {
        const key = `${d.repository}/${d.job_name}/${d.versionMinor ?? ""}`;
        const isOpen = expanded === key;
        return (
          <div
            key={key}
            data-testid="executed-drop-row"
            className="border-b border-wv-navy-3/40 last:border-b-0"
          >
            <button
              type="button"
              onClick={() => setExpanded((c) => (c === key ? null : key))}
              aria-expanded={isOpen}
              className="w-full flex items-center gap-4 px-5 py-3 text-left hover:bg-wv-navy-2/60 transition-colors"
            >
              <ChevronRight
                size={16}
                strokeWidth={1.75}
                className={[
                  "text-wv-fog-muted shrink-0 transition-transform duration-150",
                  isOpen ? "rotate-90 text-wv-danger" : "",
                ].join(" ")}
              />
              <AlertTriangle
                size={16}
                strokeWidth={1.75}
                className="text-wv-danger shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[13px] text-wv-fog truncate">
                  {d.job_name}
                </p>
                <p className="mt-0.5 text-[11px] text-wv-fog-muted truncate">
                  {d.repository}
                  {d.versionMinor ? ` · ${d.versionMinor}` : ""}
                </p>
              </div>
              <div className="text-right shrink-0 tabular-nums">
                <p className="font-mono text-[13px] text-wv-fog">
                  {d.prevExecuted.toLocaleString()} →{" "}
                  {d.currExecuted.toLocaleString()}
                </p>
                <p className="text-[12px] text-wv-danger">
                  −{pct(d.dropPct)} executed
                </p>
              </div>
            </button>
            {isOpen ? <ExecutedDropDetail drop={d} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Inline baseline-vs-current comparison for one drop. */
function ExecutedDropDetail({ drop: d }: { drop: ExecutedDrop }) {
  const lost = d.prevExecuted - d.currExecuted;
  return (
    <div
      data-testid="executed-drop-detail"
      className="bg-wv-ink/30 border-t border-wv-navy-3/40 px-5 py-4"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <RunSide
          label="Baseline — full run"
          tone="ok"
          when={d.prevStartedAt}
          runId={d.prevRunId}
          executed={d.prevExecuted}
          total={d.prevTotal}
          jobUrl={d.prevJobUrl}
        />
        <RunSide
          label="Now — fewer tests"
          tone="bad"
          when={d.currStartedAt}
          runId={d.currRunId}
          executed={d.currExecuted}
          total={d.currTotal}
          jobUrl={d.currJobUrl}
        />
      </div>
      <p className="mt-3 text-[12px] text-wv-fog-muted">
        <span className="text-wv-danger font-medium">
          −{lost.toLocaleString()} tests
        </span>{" "}
        executed vs the baseline run (−{pct(d.dropPct)}). Open both CI jobs
        above to see what stopped running.
      </p>
    </div>
  );
}

function RunSide({
  label,
  tone,
  when,
  runId,
  executed,
  total,
  jobUrl,
}: {
  label: string;
  tone: "ok" | "bad";
  when: string;
  runId: string;
  executed: number;
  total: number;
  jobUrl: string;
}) {
  return (
    <div className="rounded-md border border-wv-navy-3/40 bg-wv-navy/60 px-4 py-3">
      <p
        className={[
          "text-[11px] uppercase tracking-[0.16em] font-mono",
          tone === "bad" ? "text-wv-danger" : "text-wv-green",
        ].join(" ")}
      >
        {label}
      </p>
      <p className="mt-1.5 font-mono text-[13px] text-wv-fog tabular-nums">
        {executed.toLocaleString()}{" "}
        <span className="text-wv-fog-muted">
          / {total.toLocaleString()} executed
        </span>
      </p>
      <p
        className="mt-0.5 text-[11px] text-wv-fog-muted font-mono truncate"
        title={runId}
      >
        {fmtWhen(when)} · {runId}
      </p>
      <a
        href={jobUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-[12px] text-wv-fog-muted hover:text-wv-fog transition-colors"
      >
        View CI job
        <ArrowUpRight size={12} strokeWidth={1.75} />
      </a>
    </div>
  );
}
