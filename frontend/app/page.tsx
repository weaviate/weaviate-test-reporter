"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  ChevronRight,
  FlaskConical,
  GitCommitHorizontal,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { RunFilterBar } from "@/components/RunFilterBar";
import { useAsync } from "@/lib/useAsync";
import {
  fetchCasesForRun,
  fetchRecentRuns,
  fetchRunById,
  type RunFilters,
} from "@/lib/queries";
import { RECENT_RUNS_LIMIT } from "@/lib/constants";
import type { TestRun } from "@/lib/types";
import { summarizeRunCounts } from "@/lib/analysis";

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
      {run.job_url ? (
        <div className="mb-3 flex justify-end">
          <a
            href={run.job_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-wv-fog-muted hover:text-wv-fog transition-colors"
          >
            View CI job
            <ArrowUpRight size={12} strokeWidth={1.75} />
          </a>
        </div>
      ) : null}
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
                <Link
                  href={`/tests?suite=${encodeURIComponent(c.test_suite)}&name=${encodeURIComponent(c.name)}&from=explorer`}
                  className="min-w-0 flex-1 font-mono text-[13px] text-wv-fog hover:text-wv-green transition-colors truncate"
                  data-testid="case-history-link"
                  title="Open this test's history"
                >
                  {c.name}
                </Link>
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

/** Compact run-level count summary (WS1 D2): `154/167 · 3 failed · 10 skipped`.
 *  Renders nothing for legacy rows that carry no counts. */
function RunCounts({ run }: { run: TestRun }) {
  const segs = summarizeRunCounts(run);
  if (segs.length === 0) return null;
  return (
    <p
      data-testid="run-counts"
      className="mt-0.5 flex items-center gap-1.5 text-[11px] font-mono tabular-nums"
    >
      {segs.map((seg, i) => (
        <span key={seg.text} className="flex items-center gap-1.5">
          {i > 0 ? (
            <span aria-hidden="true" className="opacity-40">
              ·
            </span>
          ) : null}
          <span
            className={
              seg.tone === "bad" ? "text-wv-danger" : "text-wv-fog-muted"
            }
          >
            {seg.text}
          </span>
        </span>
      ))}
    </p>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
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
          <RunCounts run={run} />
        </div>
        <div className="hidden md:block text-right shrink-0 w-[100px]">
          <p className="font-mono text-[12px] text-wv-fog tabular-nums">
            {formatDuration(run.total_duration_ms)}
          </p>
          <p className="text-[11px] text-wv-fog-muted">{run.trigger_type}</p>
        </div>
        <div
          className="hidden lg:block text-right shrink-0 w-[170px] font-mono text-[11px] text-wv-fog-muted"
          title="Run start time (UTC)"
        >
          {formatTimestamp(run.started_at)}
        </div>
        <a
          href={run.job_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="
            shrink-0 inline-flex items-center justify-center
            w-7 h-7 rounded-md text-wv-fog-muted hover:text-wv-fog
            hover:bg-wv-navy-3/40 transition-colors
          "
          aria-label="Open CI job in GitHub"
        >
          <ArrowUpRight size={14} strokeWidth={1.75} />
        </a>
      </button>

      {expanded ? <ExpandedRunBody run={run} /> : null}
    </div>
  );
}

function initialFiltersFromURL(params: URLSearchParams | null): RunFilters {
  // Deep-link entry points (e.g., from the Versions landing page card
  // -> `/?versionMinor=1.37`). Existing user-typed search / multi-select
  // state lives in component state from here on.
  if (!params) return {};
  const seed: RunFilters = {};
  const versionMinors = params.getAll("versionMinor").filter(Boolean);
  if (versionMinors.length) seed.versionMinors = versionMinors;
  const versionFulls = params.getAll("versionFull").filter(Boolean);
  if (versionFulls.length) seed.versionFulls = versionFulls;
  const repos = params.getAll("repository").filter(Boolean);
  if (repos.length) seed.repositories = repos;
  const statuses = params.getAll("status").filter(Boolean);
  if (statuses.length) seed.statuses = statuses;
  const search = params.get("search")?.trim();
  if (search) seed.search = search;
  return seed;
}

export default function TestExplorerPage() {
  // `useSearchParams` requires a Suspense boundary under static export
  // (the search params are only known at request time). Wrap the inner
  // body so the page can still pre-render the chrome.
  return (
    <Suspense fallback={<LoadingState label="Loading runs…" />}>
      <TestExplorerBody />
    </Suspense>
  );
}

function TestExplorerBody() {
  const searchParams = useSearchParams();
  // useState initializer runs once — captures the URL-seeded filters
  // on first render. Subsequent navigation back to / preserves whatever
  // the user typed; deep-links from /versions still work.
  const [filters, setFilters] = useState<RunFilters>(() =>
    initialFiltersFromURL(searchParams),
  );
  // Paginate by growing the limit; useAsync keeps prior data during the
  // refetch, so "Load more" doesn't flash the list.
  const [limit, setLimit] = useState(RECENT_RUNS_LIMIT);
  const runs = useAsync(
    () => fetchRecentRuns(filters, limit),
    [
      filters.search ?? "",
      (filters.repositories ?? []).join("|"),
      (filters.statuses ?? []).join("|"),
      (filters.versionMinors ?? []).join("|"),
      (filters.versionFulls ?? []).join("|"),
      limit,
    ],
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  // Deep-link from Agent citations (`/?run=<uuid>`): pin that run above the
  // list, auto-expanded, even when it's older than the loaded page.
  const pinnedUuid = searchParams.get("run");
  const pinned = useAsync(
    () => (pinnedUuid ? fetchRunById(pinnedUuid) : Promise.resolve(null)),
    [pinnedUuid ?? ""],
  );
  const [pinnedExpanded, setPinnedExpanded] = useState(true);

  // A new filter query starts back at the first page.
  const handleFilterChange = (next: RunFilters) => {
    setFilters(next);
    setLimit(RECENT_RUNS_LIMIT);
  };

  // Don't render the pinned run twice.
  const listRuns = (runs.data ?? []).filter((r) => r.uuid !== pinnedUuid);
  const canLoadMore = !!runs.data && runs.data.length >= limit && limit < 1000;

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

      <section
        className="px-8 py-8 wv-reveal"
        style={{ animationDelay: "80ms" }}
      >
        <div className="mb-5">
          <RunFilterBar filters={filters} onChange={handleFilterChange} />
        </div>

        {pinnedUuid ? (
          <div className="mb-5" data-testid="pinned-run">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
                Linked run
              </p>
              <Link
                href="/"
                className="text-[12px] text-wv-fog-muted hover:text-wv-fog transition-colors"
              >
                clear
              </Link>
            </div>
            <div className="rounded-lg border border-wv-green/40 bg-wv-navy-2/40 overflow-hidden">
              {pinned.loading ? (
                <LoadingState label="Loading linked run…" />
              ) : pinned.error ? (
                <div className="p-4">
                  <ErrorState error={pinned.error} />
                </div>
              ) : pinned.data ? (
                <RunRow
                  run={pinned.data}
                  expanded={pinnedExpanded}
                  onToggle={() => setPinnedExpanded((v) => !v)}
                />
              ) : (
                <p className="px-5 py-4 text-[13px] text-wv-fog-muted">
                  That run wasn&apos;t found — it may have aged out of the
                  index.
                </p>
              )}
            </div>
          </div>
        ) : null}

        <div className="rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 backdrop-blur-sm overflow-hidden">
          <header className="flex items-center gap-3 px-5 py-3 border-b border-wv-navy-3/40 text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
            <GitCommitHorizontal size={14} strokeWidth={1.75} />
            <span data-testid="run-count-label">
              TestRun · {runs.data ? `${listRuns.length} shown` : "loading"}
            </span>
          </header>

          {runs.loading && !runs.data ? (
            <LoadingState />
          ) : runs.error ? (
            <div className="p-4">
              <ErrorState error={runs.error} />
            </div>
          ) : listRuns.length > 0 ? (
            <div>
              {listRuns.map((r) => (
                <RunRow
                  key={r.uuid}
                  run={r}
                  expanded={expanded === r.uuid}
                  onToggle={() =>
                    setExpanded((current) =>
                      current === r.uuid ? null : r.uuid,
                    )
                  }
                />
              ))}
            </div>
          ) : pinnedUuid ? (
            <p className="px-5 py-6 text-[13px] text-wv-fog-muted">
              No other runs match — showing only the linked run above.
            </p>
          ) : (
            <EmptyState
              Icon={FlaskConical}
              title="No runs ingested yet."
              description="Add the Weaviate Test Reporter action to a workflow and push results to populate this view."
            />
          )}
        </div>

        {canLoadMore ? (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => setLimit((l) => l + RECENT_RUNS_LIMIT)}
              disabled={runs.loading}
              data-testid="load-more-runs"
              className="
                inline-flex items-center gap-2 px-5 py-2 rounded-md text-sm
                text-wv-fog-muted hover:text-wv-fog
                border border-wv-navy-3/60 hover:border-wv-navy-3
                disabled:opacity-50 disabled:cursor-not-allowed transition-colors
              "
            >
              {runs.loading ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
