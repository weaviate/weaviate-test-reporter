"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, ChevronRight, FlaskConical, GitCommitHorizontal } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { RunFilterBar } from "@/components/RunFilterBar";
import { useAsync } from "@/lib/useAsync";
import {
  fetchAttemptsForRun,
  fetchCasesForRun,
  fetchRecentRuns,
  type RunFilters,
} from "@/lib/queries";
import type { TestCase, TestCaseStatus, TestRun } from "@/lib/types";

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
  // Sibling attempts (F3). Skip when the run looks like a one-shot to
  // avoid a wasted fetch.
  const attempts = useAsync(
    () =>
      fetchAttemptsForRun(run.repository, run.workflow_run_id, run.job_name),
    [run.repository, run.workflow_run_id, run.job_name],
  );
  const siblings: TestRun[] = (attempts.data ?? []).filter(
    (a) => a.uuid !== run.uuid,
  );
  // Fetch each sibling's TestCases so we can show per-test status.
  // Parallel; small N (typically 1 retry, rarely > 3).
  const siblingCases = useAsync<Map<string, Map<string, TestCaseStatus>>>(
    async () => {
      const map = new Map<string, Map<string, TestCaseStatus>>();
      if (siblings.length === 0) return map;
      const results = await Promise.all(
        siblings.map(async (s) => {
          const list = await fetchCasesForRun(s.uuid);
          const byKey = new Map<string, TestCaseStatus>();
          for (const c of list) {
            byKey.set(`${c.test_suite}|${c.name}`, c.status);
          }
          return [s.uuid, byKey] as const;
        }),
      );
      for (const [uuid, byKey] of results) map.set(uuid, byKey);
      return map;
    },
    // Re-fetch only when the actual sibling-uuid SET changes.
    [siblings.map((s) => s.uuid).sort().join("|")],
  );
  return (
    <div className="bg-wv-ink/30 border-t border-wv-navy-3/40 px-5 py-4">
      {attempts.data && attempts.data.length > 1 ? (
        <AttemptStrip attempts={attempts.data} currentUuid={run.uuid} />
      ) : null}
      {cases.loading ? (
        <LoadingState label="Loading failed cases…" />
      ) : cases.error ? (
        <ErrorState error={cases.error} />
      ) : cases.data && cases.data.length > 0 ? (
        <ul className="space-y-2">
          {cases.data.map((c) => (
            <FailedCaseRow
              key={c.uuid}
              testCase={c}
              siblings={siblings}
              siblingCases={siblingCases.data ?? null}
            />
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

function AttemptStrip({
  attempts,
  currentUuid,
}: {
  attempts: TestRun[];
  currentUuid: string;
}) {
  return (
    <div
      className="mb-3 flex items-center gap-2 text-[11px]"
      data-testid="attempt-strip"
    >
      <span className="font-mono uppercase tracking-[0.18em] text-wv-fog-muted">
        Attempts
      </span>
      {attempts.map((a) => {
        const isCurrent = a.uuid === currentUuid;
        const isFailure = a.status === "failure";
        return (
          <span
            key={a.uuid}
            data-testid={`attempt-chip-${a.workflow_run_attempt}`}
            data-current={isCurrent || undefined}
            className={[
              "inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono",
              isCurrent
                ? "border border-wv-green/50 bg-wv-green/10 text-wv-fog"
                : "border border-wv-navy-3/50 bg-wv-navy/40 text-wv-fog-muted",
            ].join(" ")}
            title={`Attempt ${a.workflow_run_attempt} — ${a.status}`}
          >
            <span
              aria-hidden="true"
              className={[
                "w-1.5 h-1.5 rounded-full",
                isFailure ? "bg-wv-danger" : "bg-wv-green",
              ].join(" ")}
            />
            #{a.workflow_run_attempt}
          </span>
        );
      })}
    </div>
  );
}

function FailedCaseRow({
  testCase: c,
  siblings,
  siblingCases,
}: {
  testCase: TestCase;
  siblings: TestRun[];
  siblingCases: Map<string, Map<string, TestCaseStatus>> | null;
}) {
  const key = `${c.test_suite}|${c.name}`;
  const recovered = siblingCases
    ? siblings.some(
        (s) => siblingCases.get(s.uuid)?.get(key) === "passed",
      )
    : false;
  return (
    <li
      className="rounded-md border border-wv-navy-3/40 px-4 py-3 bg-wv-navy/60"
      data-testid="failed-case-row"
      data-flake-suspect={recovered || undefined}
    >
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <p className="font-mono text-[13px] text-wv-fog truncate">
          {c.name}
        </p>
        <span className="text-[11px] font-mono text-wv-fog-muted shrink-0">
          {c.test_suite}
        </span>
      </div>
      {siblingCases && siblings.length > 0 ? (
        <AttemptStatusChips
          siblings={siblings}
          siblingCases={siblingCases}
          caseKey={key}
        />
      ) : null}
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
  );
}

function AttemptStatusChips({
  siblings,
  siblingCases,
  caseKey,
}: {
  siblings: TestRun[];
  siblingCases: Map<string, Map<string, TestCaseStatus>>;
  caseKey: string;
}) {
  return (
    <div
      className="mb-2 flex items-center gap-1.5 text-[10px] font-mono"
      data-testid="attempt-status-chips"
    >
      <span className="uppercase tracking-[0.16em] text-wv-fog-muted">
        Other attempts:
      </span>
      {siblings.map((s) => {
        const status = siblingCases.get(s.uuid)?.get(caseKey);
        const tone =
          status === "passed"
            ? "border-wv-green/50 bg-wv-green/10 text-wv-green"
            : status === "failed"
              ? "border-wv-danger/40 bg-wv-danger/10 text-wv-danger"
              : "border-wv-navy-3/50 bg-wv-navy/40 text-wv-fog-muted";
        const label =
          status === "passed"
            ? `🟢 attempt #${s.workflow_run_attempt} passed`
            : status === "failed"
              ? `🔴 attempt #${s.workflow_run_attempt} failed`
              : `· attempt #${s.workflow_run_attempt} no data`;
        return (
          <span
            key={s.uuid}
            data-testid={`attempt-status-${s.workflow_run_attempt}`}
            data-attempt-status={status ?? "unknown"}
            title={
              status === "passed"
                ? `Passed in attempt #${s.workflow_run_attempt} — flake suspect`
                : status === "failed"
                  ? `Also failed in attempt #${s.workflow_run_attempt}`
                  : `Not present in attempt #${s.workflow_run_attempt}`
            }
            className={`inline-flex items-center px-1.5 py-0.5 rounded border ${tone}`}
          >
            {label}
          </span>
        );
      })}
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
  const runs = useAsync(
    () => fetchRecentRuns(filters, 50),
    [
      filters.search ?? "",
      (filters.repositories ?? []).join("|"),
      (filters.statuses ?? []).join("|"),
      (filters.versionMinors ?? []).join("|"),
      (filters.versionFulls ?? []).join("|"),
    ],
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
