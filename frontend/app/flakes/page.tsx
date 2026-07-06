"use client";

import { useState } from "react";
import Link from "next/link";
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
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const flakes = useAsync(() => fetchFlakyTests(window), [window]);

  const data = flakes.data ?? [];
  const versionGroups = groupByVersion(data);
  const filtered =
    selectedVersion === null
      ? data
      : data.filter((r) => (r.version_minor ?? "") === selectedVersion);

  return (
    <>
      <PageHeader
        eyebrow="Flakes"
        title="Tests that flip"
        description="Ranked by flakiness score (transitions per observation), computed per version. Stable tests and anything under 3 runs in the window are filtered out."
        right={
          <div
            className="inline-flex rounded-md border border-wv-navy-3/60 overflow-hidden"
            data-testid="flakes-window-picker"
          >
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  setWindow(w.id);
                  setSelectedVersion(null);
                }}
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

      <section className="px-8 py-8 space-y-5">
        {flakes.loading ? (
          <LoadingState label="Scanning the window for status flips…" />
        ) : flakes.error ? (
          <ErrorState error={flakes.error} />
        ) : data.length === 0 ? (
          <EmptyState
            Icon={ActivitySquare}
            title="No flakes in this window"
            description="Either everything has been stable (great!) or there aren't enough runs yet. Try a longer window."
          />
        ) : (
          <>
            <VersionBar
              groups={versionGroups}
              total={data.length}
              selected={selectedVersion}
              onSelect={setSelectedVersion}
            />
            <FlakeTable
              rows={filtered}
              selectedLabel={
                selectedVersion === null ? null : versionLabel(selectedVersion)
              }
            />
          </>
        )}
      </section>
    </>
  );
}

function versionLabel(key: string): string {
  return key === "" ? "no version" : key;
}

/** Distinct versions present in the flake rows, with per-version counts; newest
 *  minor first. Powers the "By version" boxes. */
function groupByVersion(
  rows: FlakyTest[],
): { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.version_minor ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: versionLabel(key), count }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

function VersionBar({
  groups,
  total,
  selected,
  onSelect,
}: {
  groups: { key: string; label: string; count: number }[];
  total: number;
  selected: string | null;
  onSelect: (v: string | null) => void;
}) {
  // Only worth showing when there's more than one version to slice by.
  if (groups.length <= 1) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="flakes-version-bar"
    >
      <span className="mr-1 text-[11px] uppercase tracking-[0.18em] font-mono text-wv-fog-muted">
        By version
      </span>
      <VersionChip
        label="All versions"
        count={total}
        active={selected === null}
        onClick={() => onSelect(null)}
      />
      {groups.map((g) => (
        <VersionChip
          key={g.key}
          label={g.label}
          count={g.count}
          active={selected === g.key}
          onClick={() => onSelect(g.key)}
        />
      ))}
    </div>
  );
}

function VersionChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={`flakes-version-chip-${label}`}
      className={[
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] transition-colors",
        active
          ? "border-wv-green/60 bg-wv-green/10 text-wv-fog"
          : "border-wv-navy-3/60 text-wv-fog-muted hover:text-wv-fog hover:border-wv-navy-3",
      ].join(" ")}
    >
      <span className="font-mono">{label}</span>
      <span className="tabular-nums text-wv-fog-muted">{count}</span>
    </button>
  );
}

function FlakeTable({
  rows,
  selectedLabel,
}: {
  rows: FlakyTest[];
  selectedLabel: string | null;
}) {
  return (
    <div
      className="rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 backdrop-blur-sm overflow-hidden"
      data-testid="flakes-table"
    >
      <header className="flex items-center gap-3 px-5 py-3 border-b border-wv-navy-3/40 text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
        <Zap size={14} strokeWidth={1.75} />
        <span data-testid="flakes-count">
          {rows.length} flak{rows.length === 1 ? "y test" : "y tests"}
          {selectedLabel ? ` on ${selectedLabel}` : ""}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.18em] font-mono text-wv-fog-muted">
              <th className="text-left px-5 py-2 font-medium">Test</th>
              <th className="text-left px-3 py-2 font-medium">Suite</th>
              <th className="text-left px-3 py-2 font-medium">Version</th>
              <th className="text-left px-3 py-2 font-medium">Job</th>
              <th className="text-right px-3 py-2 font-medium">Flakiness</th>
              <th className="text-right px-3 py-2 font-medium">Runs</th>
              <th className="text-right px-3 py-2 font-medium">Pass rate</th>
              <th className="text-left px-3 py-2 font-medium">
                Last{" "}
                {Math.min(
                  20,
                  rows.reduce(
                    (m, r) => Math.max(m, r.recent_statuses.length),
                    0,
                  ),
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <FlakeRow
                key={`${r.test_suite}|${r.name}|${r.version_minor ?? ""}|${r.job_name}`}
                row={r}
              />
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
      <td className="px-5 py-2.5 font-mono text-[13px]">
        <Link
          href={`/tests?suite=${encodeURIComponent(row.test_suite)}&name=${encodeURIComponent(row.name)}&from=flakes`}
          className="text-wv-fog hover:text-wv-green transition-colors"
          data-testid="flake-history-link"
        >
          {row.name}
        </Link>
      </td>
      <td className="px-3 py-2.5 text-[12px] text-wv-fog-muted font-mono">
        {row.test_suite}
      </td>
      <td className="px-3 py-2.5 text-[12px] text-wv-fog-muted font-mono tabular-nums">
        {row.version_minor ?? "—"}
      </td>
      <td className="px-3 py-2.5 text-[12px] text-wv-fog-muted font-mono">
        <span className="block max-w-[220px] truncate" title={row.job_name}>
          {row.job_name || "—"}
        </span>
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
