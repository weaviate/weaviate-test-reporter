"use client";

import { ArrowUpRight } from "lucide-react";
import type { TestHistory } from "@/lib/queries";
import { groupHistoryByJob } from "@/lib/analysis";

const cellTone = (status: string): string =>
  status === "passed"
    ? "bg-wv-green/70"
    : status === "failed"
      ? "bg-wv-danger/80"
      : "bg-wv-navy-3";

const fmtDate = (iso: string): string => (iso ? iso.slice(0, 10) : "—");
const fmtPct = (n: number): string => `${Math.round(n * 100)}%`;
const context = (p: { versionMinor: string | null; branch: string | null }) =>
  `${p.versionMinor ? ` · ${p.versionMinor}` : ""}${p.branch ? ` · ${p.branch}` : ""}`;

/**
 * The single-test history view (WS3 R1): summary stats, a pass/fail timeline
 * (each cell links to that run's CI job), and the recent failure messages.
 * A dumb visual layer — the page fetches and handles loading/error.
 */
export function TestHistoryView({ history }: { history: TestHistory }) {
  const failures = history.points
    .filter((p) => p.status === "failed")
    .slice(-8)
    .reverse();

  return (
    <div className="space-y-8">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Runs" value={history.totalRuns.toLocaleString()} />
        <Stat
          label="Passed"
          value={history.passed.toLocaleString()}
          tone="good"
        />
        <Stat
          label="Failed"
          value={history.failed.toLocaleString()}
          tone={history.failed > 0 ? "bad" : undefined}
        />
        <Stat label="Skipped" value={history.skipped.toLocaleString()} />
        <Stat
          label="Flakiness"
          value={fmtPct(history.flakinessScore)}
          tone={history.flakinessScore >= 0.3 ? "bad" : undefined}
        />
      </dl>

      <div>
        <p className="mb-3 text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
          Timeline by job (oldest → newest)
        </p>
        {history.points.length === 0 ? (
          <p className="text-[13px] text-wv-fog-muted">
            No runs recorded for this test.
          </p>
        ) : (
          <div className="space-y-2.5" data-testid="history-timeline">
            {groupHistoryByJob(history.points).map(({ job, points }) => (
              // Key on the raw job (unique per series; "" = the no-job bucket),
              // prefixed so the key is non-empty and can't collide with a real
              // job literally named "—" (the display placeholder below).
              <div
                key={`job:${job}`}
                className="flex items-start gap-3"
                data-testid="history-job-series"
              >
                <span
                  className="w-52 shrink-0 truncate pt-0.5 text-[12px] font-mono text-wv-fog-muted"
                  title={job || "no job"}
                >
                  {job || "— no job"}
                </span>
                <div className="flex flex-wrap gap-1">
                  {points.map((p, i) => {
                    const label = `${p.status} · ${fmtDate(p.runStartedAt)}${context(p)}`;
                    return (
                      <a
                        key={`${p.runId}-${i}`}
                        href={p.jobUrl || undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={label}
                        aria-label={label}
                        className={`h-6 w-3 rounded-sm ${cellTone(p.status)} transition-shadow hover:ring-2 hover:ring-wv-fog/40`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {failures.length > 0 ? (
        <div>
          <p className="mb-3 text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
            Recent failures
          </p>
          <div className="space-y-2">
            {failures.map((p, i) => (
              <a
                key={`${p.runId}-f${i}`}
                href={p.jobUrl || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md border border-wv-navy-3/40 bg-wv-navy-2/40 px-4 py-3 hover:bg-wv-navy-2/60 transition-colors"
              >
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="text-[12px] font-mono text-wv-danger">
                    {p.failureType ?? "failed"}
                  </span>
                  <span className="shrink-0 text-[11px] font-mono text-wv-fog-muted">
                    {fmtDate(p.runStartedAt)}
                    {context(p)}
                    <ArrowUpRight
                      size={12}
                      className="ml-1 -mt-0.5 inline-block"
                    />
                  </span>
                </div>
                {p.errorMessage ? (
                  <p className="text-[13px] text-wv-fog/90 break-words">
                    {p.errorMessage}
                  </p>
                ) : null}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-wv-green"
      : tone === "bad"
        ? "text-wv-danger"
        : "text-wv-fog";
  return (
    <div className="rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 p-4">
      <p className="text-[11px] uppercase tracking-[0.15em] font-mono text-wv-fog-muted">
        {label}
      </p>
      <p className={`font-display text-2xl mt-1 tabular-nums ${color}`}>
        {value}
      </p>
    </div>
  );
}
