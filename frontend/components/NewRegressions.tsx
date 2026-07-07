"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2 } from "lucide-react";
import type { RegressionReport } from "@/lib/queries";

const fmtDate = (iso: string): string => (iso ? iso.slice(0, 10) : "—");

/**
 * NEW regressions (WS3 R2): tests that started failing in the current window
 * and did NOT fail in the prior window — with known flakes and already-recurring
 * failures suppressed. A dumb visual layer; the parent fetches + handles
 * loading/error. Each row deep-links to the test's version-scoped history.
 */
export function NewRegressions({ report }: { report: RegressionReport }) {
  const known = report.knownFlakyCount + report.recurringCount;

  if (report.newCount === 0) {
    return (
      <div
        data-testid="regressions-clear"
        className="flex items-center gap-3 rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 px-5 py-4 text-[13px] text-wv-fog-muted"
      >
        <CheckCircle2 size={16} className="text-wv-green shrink-0" />
        No new test failures this window
        {known > 0
          ? ` — ${known} already-known failing (flaky / recurring).`
          : "."}
      </div>
    );
  }

  return (
    <div
      data-testid="new-regressions"
      className="rounded-lg border border-wv-danger/30 bg-wv-navy-2/40 overflow-hidden"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3 border-b border-wv-navy-3/40 text-[12px] font-mono">
        <span className="font-medium text-wv-danger">
          {report.newCount} NEW
        </span>
        <span className="text-wv-fog-muted">
          · {known} known suppressed ({report.knownFlakyCount} flaky,{" "}
          {report.recurringCount} recurring)
        </span>
      </header>
      {report.regressions.map((r) => (
        <Link
          key={`${r.test_suite}|${r.name}|${r.version_minor ?? ""}|${r.job_name}`}
          href={`/tests?suite=${encodeURIComponent(r.test_suite)}&name=${encodeURIComponent(r.name)}${r.version_minor ? `&version=${encodeURIComponent(r.version_minor)}` : ""}&from=dashboard`}
          className="flex items-start gap-4 px-5 py-3 border-b border-wv-navy-3/40 last:border-b-0 hover:bg-wv-navy-2/60 transition-colors"
          data-testid="regression-row"
        >
          <AlertTriangle
            size={16}
            strokeWidth={1.75}
            className="mt-0.5 text-wv-danger shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[13px] text-wv-fog truncate">
              {r.name}
            </p>
            <p className="mt-0.5 text-[11px] text-wv-fog-muted truncate">
              {r.test_suite}
              {r.version_minor ? ` · ${r.version_minor}` : ""} · {r.job_name}
            </p>
            {r.lastErrorMessage ? (
              <p className="mt-1 text-[12px] text-wv-danger/90 break-words line-clamp-2">
                {r.lastErrorMessage}
              </p>
            ) : null}
          </div>
          <div className="text-right shrink-0 tabular-nums">
            <p className="font-mono text-[13px] text-wv-danger">
              ×{r.failCount}
            </p>
            <p className="text-[11px] text-wv-fog-muted">
              since {fmtDate(r.firstFailedAt)}
            </p>
          </div>
          <ArrowUpRight
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 text-wv-fog-muted shrink-0"
          />
        </Link>
      ))}
    </div>
  );
}
