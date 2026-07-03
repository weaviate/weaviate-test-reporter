"use client";

import { MultiSelectFilter } from "./MultiSelectFilter";
import { useAsync } from "@/lib/useAsync";
import { fetchDistinctRunValues } from "@/lib/queries";
import type { TrendFilters } from "@/lib/queries";

/**
 * Repo / branch / minor-version slicing for the dashboard trend charts (WS2 H2).
 * Options come straight from Weaviate Aggregate groupBy; every change publishes
 * the next filter state to the parent, which re-fetches the trend series.
 * Scopes the charts only — the KPI tiles above stay global.
 */
export function TrendFilterBar({
  filters,
  onChange,
}: {
  filters: TrendFilters;
  onChange: (next: TrendFilters) => void;
}) {
  const repoOptions = useAsync(() => fetchDistinctRunValues("repository"), []);
  const branchOptions = useAsync(() => fetchDistinctRunValues("branch"), []);
  const versionOptions = useAsync(
    () => fetchDistinctRunValues("version_minor"),
    [],
  );

  const anyActive =
    (filters.repositories?.length ?? 0) > 0 ||
    (filters.branches?.length ?? 0) > 0 ||
    (filters.versionMinors?.length ?? 0) > 0;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="trend-filter-bar"
    >
      <MultiSelectFilter
        label="Repository"
        testId="trend-filter-repository"
        options={repoOptions.data ?? []}
        selected={filters.repositories ?? []}
        onChange={(next) => onChange({ ...filters, repositories: next })}
        placeholder="Filter repositories…"
        emptyHint={repoOptions.loading ? "Loading…" : "No repositories yet."}
      />
      <MultiSelectFilter
        label="Branch"
        testId="trend-filter-branch"
        options={branchOptions.data ?? []}
        selected={filters.branches ?? []}
        onChange={(next) => onChange({ ...filters, branches: next })}
        placeholder="Filter branches…"
        emptyHint={branchOptions.loading ? "Loading…" : "No branches yet."}
      />
      <MultiSelectFilter
        label="Minor version"
        testId="trend-filter-version-minor"
        options={versionOptions.data ?? []}
        selected={filters.versionMinors ?? []}
        onChange={(next) => onChange({ ...filters, versionMinors: next })}
        placeholder="Filter minor versions…"
        emptyHint={
          versionOptions.loading
            ? "Loading…"
            : "No versions recorded yet — set version_under_test on the action."
        }
      />
      {anyActive ? (
        <button
          type="button"
          onClick={() => onChange({})}
          className="text-[12px] text-wv-fog-muted hover:text-wv-fog px-2 py-1"
          data-testid="trend-filter-clear-all"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
