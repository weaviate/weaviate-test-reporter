"use client";

import { useState } from "react";
import { ArrowUpRight, ChevronRight, FlaskConical, GitCommitHorizontal } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { RunFilterBar } from "@/components/RunFilterBar";
import { useAsync } from "@/lib/useAsync";
import { fetchCasesForRun, fetchRecentRuns, type RunFilters } from "@/lib/queries";
import type { TestRun } from "@/lib/types";

function formatTimestamp(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatDuration(ms: number): string {
  if (!ms) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function ExpandedRunBody({ run }: { run: TestRun }) {
  // Only mounted when the row is expanded — so the Weaviate fetch only
  // fires for runs the user is actually inspecting.
  const cases = useAsync(
    () => fetchCasesForRun(run.uuid, { failedOnly: true }),
    [run.uuid],
  );
  return (
    <div className="bg-wv-ink/30 border-t border-wv-navy-3/40 px-5 py-4">
      {cases.loading ? (
        <LoadingState label="Loading failed cases…" />
      ) : cases.error ? (
        <ErrorState error={cases.error} />
      ) : cases.data && cases.data.length > 0 ? (
        <ul className="space-y-2">
          {cases.data.map((c) => (
            <li
              key={c.uuid}
              className="rounded-md border border-wv-navy-3/40 px-4 py-3 bg-wv-navy/60"
            >
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <p className="font-mono text-[13px] text-wv-fog truncate">
                  {c.name}
                </p>
                <span className="text-[11px] font-mono text-wv-fog-muted shrink-0">
                  {c.test_suite}
                </span>
              </div>
              {c.failure_type ? (
                <p className="text-[12px] text-wv-danger font-mono mb-1">
                  {c.failure_type}
                </p>
              ) : null}
              {c.error_message ? (
                <p className="text-[13px] text-wv-fog/90">{c.error_message}</p>
              ) : null}
              {c.stack_trace ? (
                <pre className="mt-2 font-mono text-[11px] leading-relaxed text-wv-fog-muted whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {c.stack_trace}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-wv-fog-muted py-2">
          No failed cases — every test in this run passed or was skipped.
        </p>
      )}
    </div>
  );
}


function RunRow({ run, expanded, onToggle }: {
  run: TestRun;
  expanded: boolean;
  onToggle: () => void;
}) {

  return (
    <div
      className="border-b border-wv-navy-3/40 last:border-b-0"
      data-testid="run-row"
      data-run-uuid={run.uuid}
      data-run-repository={run.repository}
      data-run-status={run.status}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="
          w-full flex items-center gap-4 px-5 py-3.5
          text-left hover:bg-wv-navy-2/40 transition-colors
        "
      >
        <ChevronRight
          size={16}
          strokeWidth={1.75}
          className={[
            "text-wv-fog-muted shrink-0 transition-transform duration-150",
            expanded ? "rotate-90 text-wv-green" : "",
          ].join(" ")}
        />
        <div className="w-[110px] shrink-0">
          <StatusBadge status={run.status} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[13px] text-wv-fog truncate">
            {run.run_id}
          </p>
          <p className="mt-0.5 text-[11px] text-wv-fog-muted truncate">
            <span className="text-wv-fog">{run.actor}</span>
            <span className="mx-1.5 opacity-40">·</span>
            {run.branch}
            <span className="mx-1.5 opacity-40">·</span>
            {run.commit_hash.slice(0, 8)}
            {run.pr_number != null ? (
              <>
                <span className="mx-1.5 opacity-40">·</span>
                PR #{run.pr_number}
              </>
            ) : null}
          </p>
        </div>
        <div className="hidden md:block text-right shrink-0 w-[100px]">
          <p className="font-mono text-[12px] text-wv-fog tabular-nums">
            {formatDuration(run.total_duration_ms)}
          </p>
          <p className="text-[11px] text-wv-fog-muted">{run.trigger_type}</p>
        </div>
        <div className="hidden lg:block text-right shrink-0 w-[170px] font-mono text-[11px] text-wv-fog-muted">
          {formatTimestamp(run.timestamp)}
        </div>
        <a
          href={run.run_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="
            shrink-0 inline-flex items-center justify-center
            w-7 h-7 rounded-md text-wv-fog-muted hover:text-wv-fog
            hover:bg-wv-navy-3/40 transition-colors
          "
          aria-label="Open run in GitHub"
        >
          <ArrowUpRight size={14} strokeWidth={1.75} />
        </a>
      </button>

      {expanded ? <ExpandedRunBody run={run} /> : null}
    </div>
  );
}

export default function TestExplorerPage() {
  const [filters, setFilters] = useState<RunFilters>({});
  const runs = useAsync(
    () => fetchRecentRuns(filters, 50),
    [
      filters.search ?? "",
      (filters.repositories ?? []).join("|"),
      (filters.statuses ?? []).join("|"),
    ]
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        eyebrow="Test Explorer"
        title="Recent test runs"
        description="Click a row to expand its failed TestCases. Vectors for error messages live one click away in the Semantic Search tab."
        right={
          <a
            href="https://docs.weaviate.io"
            target="_blank"
            rel="noopener noreferrer"
            className="
              inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm
              text-wv-fog-muted hover:text-wv-fog
              border border-wv-navy-3/60 hover:border-wv-navy-3
              transition-colors
            "
          >
            Weaviate docs
            <ArrowUpRight size={14} strokeWidth={1.75} />
          </a>
        }
      />

      <section className="px-8 py-8 wv-reveal" style={{ animationDelay: "80ms" }}>
        <div className="mb-5">
          <RunFilterBar filters={filters} onChange={setFilters} />
        </div>

        <div className="rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 backdrop-blur-sm overflow-hidden">
          <header className="flex items-center gap-3 px-5 py-3 border-b border-wv-navy-3/40 text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
            <GitCommitHorizontal size={14} strokeWidth={1.75} />
            <span data-testid="run-count-label">
              TestRun · {runs.data ? `${runs.data.length} most recent` : "loading"}
            </span>
          </header>

          {runs.loading ? (
            <LoadingState />
          ) : runs.error ? (
            <div className="p-4">
              <ErrorState error={runs.error} />
            </div>
          ) : runs.data && runs.data.length > 0 ? (
            <div>
              {runs.data.map((r) => (
                <RunRow
                  key={r.uuid}
                  run={r}
                  expanded={expanded === r.uuid}
                  onToggle={() =>
                    setExpanded((current) => (current === r.uuid ? null : r.uuid))
                  }
                />
              ))}
            </div>
          ) : (
            <EmptyState
              Icon={FlaskConical}
              title="No runs ingested yet."
              description="Add the Weaviate Test Reporter action to a workflow and push results to populate this view."
            />
          )}
        </div>
      </section>
    </>
  );
}
