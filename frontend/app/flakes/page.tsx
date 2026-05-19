"use client";

import { useState } from "react";
import { ActivitySquare, Zap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { fetchFlakyTests, type FlakesWindow } from "@/lib/queries";
import { useAsync } from "@/lib/useAsync";
import type { FlakyTest, TestCaseStatus } from "@/lib/types";

/**
 * Flakes — tests that flip between passed/failed within the window.
 *
 * Ranks by `flakiness_score = transitions / (runs - 1)`. Stable tests
 * (zero transitions) are filtered out by the query; tests with fewer
 * than 3 runs in the window are also filtered (not enough signal).
 *
 * Goal: a one-shot answer to "what should we quarantine this sprint?".
 */
const WINDOWS: { id: FlakesWindow; label: string }[] = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

export default function FlakesPage() {
  const [window, setWindow] = useState<FlakesWindow>("7d");
  const flakes = useAsync(() => fetchFlakyTests(window), [window]);

  return (
    <>
      <PageHeader
        eyebrow="Flakes"
        title="Tests that flip"
        description="Ranked by flakiness score (transitions per observation). Stable tests and anything under 3 runs in the window are filtered out."
        right={
          <div
            className="inline-flex rounded-md border border-wv-navy-3/60 overflow-hidden"
            data-testid="flakes-window-picker"
          >
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWindow(w.id)}
                aria-pressed={window === w.id}
                className={[
                  "px-3 py-1.5 text-sm transition-colors",
                  window === w.id
                    ? "bg-wv-green/10 text-wv-fog"
                    : "text-wv-fog-muted hover:text-wv-fog hover:bg-wv-navy-2",
                ].join(" ")}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      <section className="px-8 py-8">
        {flakes.loading ? (
          <LoadingState label="Scanning the window for status flips…" />
        ) : flakes.error ? (
          <ErrorState error={flakes.error} />
        ) : !flakes.data || flakes.data.length === 0 ? (
          <EmptyState
            Icon={ActivitySquare}
            title="No flakes in this window"
            description="Either everything has been stable (great!) or there aren't enough runs yet. Try a longer window."
          />
        ) : (
          <FlakeTable rows={flakes.data} />
        )}
      </section>
    </>
  );
}

function FlakeTable({ rows }: { rows: FlakyTest[] }) {
  return (
    <div
      className="rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 backdrop-blur-sm overflow-hidden"
      data-testid="flakes-table"
    >
      <header className="flex items-center gap-3 px-5 py-3 border-b border-wv-navy-3/40 text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
        <Zap size={14} strokeWidth={1.75} />
        <span data-testid="flakes-count">
          {rows.length} flak{rows.length === 1 ? "y test" : "y tests"}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.18em] font-mono text-wv-fog-muted">
              <th className="text-left px-5 py-2 font-medium">Test</th>
              <th className="text-left px-3 py-2 font-medium">Suite</th>
              <th className="text-right px-3 py-2 font-medium">Flakiness</th>
              <th className="text-right px-3 py-2 font-medium">Runs</th>
              <th className="text-right px-3 py-2 font-medium">Pass rate</th>
              <th className="text-left px-3 py-2 font-medium">Last {Math.min(20, rows[0].recent_statuses.length)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <FlakeRow key={`${r.test_suite}|${r.name}`} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FlakeRow({ row }: { row: FlakyTest }) {
  const passRate = row.passed / Math.max(1, row.total_runs);
  const scorePct = Math.round(row.flakiness_score * 100);
  const tone = scoreTone(row.flakiness_score);
  return (
    <tr
      className="border-t border-wv-navy-3/30 hover:bg-wv-navy-2/40 transition-colors"
      data-testid="flake-row"
      data-flake-suite={row.test_suite}
      data-flake-name={row.name}
    >
      <td className="px-5 py-2.5 font-mono text-[13px] text-wv-fog">
        {row.name}
      </td>
      <td className="px-3 py-2.5 text-[12px] text-wv-fog-muted font-mono">
        {row.test_suite}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        <span className={`font-mono ${tone}`}>{scorePct}%</span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-wv-fog-muted">
        {row.total_runs}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-wv-fog-muted">
        {Math.round(passRate * 100)}%
      </td>
      <td className="px-3 py-2.5">
        <StatusStrip statuses={row.recent_statuses} />
      </td>
    </tr>
  );
}

function scoreTone(score: number): string {
  if (score >= 0.4) return "text-wv-danger";
  if (score >= 0.2) return "text-wv-warn";
  return "text-wv-fog";
}

function StatusStrip({ statuses }: { statuses: TestCaseStatus[] }) {
  return (
    <div className="flex items-center gap-0.5">
      {statuses.map((s, i) => (
        <span
          key={i}
          className={[
            "block w-2 h-3 rounded-sm",
            s === "passed"
              ? "bg-wv-green/80"
              : s === "failed"
                ? "bg-wv-danger/80"
                : "bg-wv-fog-muted/30",
          ].join(" ")}
          aria-label={s}
          title={s}
        />
      ))}
    </div>
  );
}
