"use client";

import { AlertTriangle, ArrowUpRight, CheckCircle2 } from "lucide-react";
import type { ExecutedDrop } from "@/lib/queries";

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Expected-vs-executed (WS2 H3): the jobs whose latest run ran fewer tests than
 * the run before. A dumb visual layer — the parent fetches and handles
 * loading/error. Empty list renders a green "all clear" instead.
 */
export function ExecutedDrops({ drops }: { drops: ExecutedDrop[] }) {
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
      {drops.map((d) => (
        <a
          key={`${d.repository}/${d.job_name}/${d.versionMinor ?? ""}`}
          href={d.currJobUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 px-5 py-3 border-b border-wv-navy-3/40 last:border-b-0 hover:bg-wv-navy-2/60 transition-colors"
        >
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
          <ArrowUpRight
            size={14}
            strokeWidth={1.75}
            className="text-wv-fog-muted shrink-0"
          />
        </a>
      ))}
    </div>
  );
}
