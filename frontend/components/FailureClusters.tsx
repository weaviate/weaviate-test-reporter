"use client";

import { Layers, CheckCircle2 } from "lucide-react";
import type { ClusterReport } from "@/lib/queries";

const fmtDate = (iso: string): string => (iso ? iso.slice(0, 10) : "—");

/**
 * Failure clusters (WS3 R4): failures grouped by their D4 `failure_fingerprint`,
 * collapsing mass-failure noise into ranked root causes. A dumb visual layer;
 * the parent fetches + handles loading/error. Exact-hash only (no fuzzy match).
 */
export function FailureClusters({ report }: { report: ClusterReport }) {
  if (report.clusters.length === 0) {
    return (
      <div
        data-testid="clusters-clear"
        className="flex items-center gap-3 rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 px-5 py-4 text-[13px] text-wv-fog-muted"
      >
        <CheckCircle2 size={16} className="text-wv-green shrink-0" />
        No mass-failure clusters this window
        {report.totalFailures > 0
          ? ` — ${report.totalFailures} failure${report.totalFailures === 1 ? "" : "s"}, but none share a root-cause fingerprint across ≥2 tests.`
          : "."}
      </div>
    );
  }

  return (
    <div
      data-testid="failure-clusters"
      className="rounded-lg border border-wv-danger/30 bg-wv-navy-2/40 overflow-hidden"
    >
      {report.clusters.map((c) => (
        <div
          key={c.fingerprint}
          data-testid="cluster-row"
          className="flex items-start gap-4 px-5 py-3 border-b border-wv-navy-3/40 last:border-b-0"
        >
          <Layers
            size={16}
            strokeWidth={1.75}
            className="mt-0.5 text-wv-danger shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-wv-fog break-words line-clamp-2">
              {c.sampleError ?? c.sampleFailureType ?? "(no error message)"}
            </p>
            <p className="mt-0.5 text-[11px] text-wv-fog-muted font-mono truncate">
              {c.sampleFailureType ? `${c.sampleFailureType} · ` : ""}fp{" "}
              {c.fingerprint.slice(0, 8)} · since {fmtDate(c.firstSeen)}
            </p>
          </div>
          <div className="text-right shrink-0 tabular-nums">
            <p className="font-mono text-[13px] text-wv-danger">
              {c.affectedTests} tests
            </p>
            <p className="text-[11px] text-wv-fog-muted">
              {c.affectedSuites} suite{c.affectedSuites === 1 ? "" : "s"} · ×
              {c.occurrences}
            </p>
          </div>
        </div>
      ))}
      {report.uncategorized > 0 ? (
        <p className="px-5 py-2.5 text-[11px] text-wv-fog-muted border-t border-wv-navy-3/40">
          + {report.uncategorized} failure
          {report.uncategorized === 1 ? "" : "s"} without a fingerprint (not
          clustered).
        </p>
      ) : null}
    </div>
  );
}
