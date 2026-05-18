"use client";

import { Search, X } from "lucide-react";
import { MultiSelectFilter } from "./MultiSelectFilter";
import type { RunFilters } from "@/lib/queries";
import { useAsync } from "@/lib/useAsync";
import { fetchDistinctRunValues } from "@/lib/queries";

/**
 * Composite filter bar for the Test Explorer.
 *
 * - Free-text search across run_id / branch / actor / commit_hash.
 * - Repository multi-select (populated from Weaviate Aggregate groupBy).
 * - Status multi-select (populated from Weaviate).
 * - "Clear all" link when any filter is active.
 *
 * Live updates: every keystroke / checkbox flip publishes the next filter
 * state to the parent via onChange. The parent re-issues the Weaviate
 * query on its side.
 */
export function RunFilterBar({
  filters,
  onChange,
}: {
  filters: RunFilters;
  onChange: (next: RunFilters) => void;
}) {
  const repoOptions = useAsync(() => fetchDistinctRunValues("repository"), []);
  const statusOptions = useAsync(() => fetchDistinctRunValues("status"), []);

  const anyActive =
    Boolean(filters.search?.trim()) ||
    (filters.repositories?.length ?? 0) > 0 ||
    (filters.statuses?.length ?? 0) > 0;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="run-filter-bar">
      <div
        className="
          flex items-center gap-2 px-3 py-1.5 rounded-md
          border border-wv-navy-3/60 hover:border-wv-navy-3
          bg-wv-navy-2/40 min-w-[260px]
        "
      >
        <Search size={14} strokeWidth={1.75} className="text-wv-fog-muted shrink-0" />
        <input
          type="text"
          value={filters.search ?? ""}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder="Search run_id, branch, actor, commit…"
          className="
            flex-1 bg-transparent text-sm text-wv-fog
            placeholder:text-wv-fog-muted/60 outline-none
          "
          aria-label="Search test runs"
          data-testid="run-search-input"
        />
        {filters.search ? (
          <button
            type="button"
            onClick={() => onChange({ ...filters, search: "" })}
            aria-label="Clear search"
            className="text-wv-fog-muted hover:text-wv-fog"
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <MultiSelectFilter
        label="Repository"
        testId="filter-repository"
        options={repoOptions.data ?? []}
        selected={filters.repositories ?? []}
        onChange={(next) => onChange({ ...filters, repositories: next })}
        placeholder="Filter repositories…"
        emptyHint={
          repoOptions.loading ? "Loading repositories…" : "No repositories yet."
        }
      />

      <MultiSelectFilter
        label="Status"
        testId="filter-status"
        options={statusOptions.data ?? []}
        selected={filters.statuses ?? []}
        onChange={(next) => onChange({ ...filters, statuses: next })}
        placeholder="Filter statuses…"
        emptyHint={statusOptions.loading ? "Loading…" : "No statuses yet."}
      />

      {anyActive ? (
        <button
          type="button"
          onClick={() => onChange({})}
          className="text-[12px] text-wv-fog-muted hover:text-wv-fog px-2 py-1"
          data-testid="filter-clear-all"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
