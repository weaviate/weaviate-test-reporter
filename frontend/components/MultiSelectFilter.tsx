"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type FilterOption = { value: string; count?: number };

/**
 * GitHub-Actions-style multi-select dropdown.
 *
 * Renders a button (`label · n` when active) that opens a panel with:
 *   - an inline search input that narrows visible options,
 *   - a checkbox list of options with their occurrence counts,
 *   - a "Clear" link to reset the selection.
 *
 * Selection updates are reported via `onChange` immediately (no apply
 * button) — feels more responsive and matches the GitHub UX.
 *
 * Dismissal: outside click or Escape. Inside the panel, Tab moves through
 * the search input and option buttons normally; Enter on a focused
 * option toggles it. Full arrow-key navigation through the option list
 * isn't implemented yet — Tab + Space/Enter cover the keyboard-only
 * flow adequately for MVP.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  placeholder = "Search…",
  emptyHint = "No options yet.",
  testId,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyHint?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the search input when the panel opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.value.toLowerCase().includes(q));
  }, [options, query]);

  function toggle(value: string) {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next);
  }

  const active = selected.length > 0;

  return (
    <div ref={rootRef} className="relative" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={[
          "inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm",
          "border transition-colors",
          active
            ? "border-wv-green/50 text-wv-fog bg-wv-green/10"
            : "border-wv-navy-3/60 text-wv-fog-muted hover:text-wv-fog hover:border-wv-navy-3",
        ].join(" ")}
      >
        <span className="font-medium">{label}</span>
        {active ? (
          <span
            className="
              inline-flex items-center justify-center
              min-w-[18px] h-[18px] px-1 rounded-full
              text-[11px] font-mono bg-wv-green text-wv-navy
            "
          >
            {selected.length}
          </span>
        ) : null}
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={[
            "transition-transform duration-150",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label={label}
          className="
            absolute z-30 mt-2 left-0
            w-72 rounded-md
            border border-wv-navy-3 bg-wv-navy-2
            shadow-[0_8px_24px_rgba(0,0,0,0.4)]
            overflow-hidden
          "
        >
          <div className="px-3 py-2 border-b border-wv-navy-3/60 flex items-center gap-2">
            <Search size={14} strokeWidth={1.75} className="text-wv-fog-muted shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="
                flex-1 bg-transparent text-sm text-wv-fog
                placeholder:text-wv-fog-muted/60 outline-none
              "
              aria-label={`Filter ${label.toLowerCase()}`}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-wv-fog-muted hover:text-wv-fog"
              >
                <X size={13} strokeWidth={1.75} />
              </button>
            ) : null}
          </div>

          <ul className="max-h-64 overflow-y-auto py-1" data-testid={testId ? `${testId}-options` : undefined}>
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-[12px] text-wv-fog-muted text-center">
                {options.length === 0 ? emptyHint : "No matches."}
              </li>
            ) : (
              filtered.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => toggle(opt.value)}
                      aria-pressed={checked}
                      className="
                        w-full flex items-center gap-2 px-3 py-1.5
                        text-left text-sm
                        hover:bg-wv-navy-3/40 transition-colors
                      "
                    >
                      <span
                        className={[
                          "shrink-0 w-4 h-4 rounded border flex items-center justify-center",
                          checked
                            ? "bg-wv-green border-wv-green"
                            : "border-wv-navy-3 bg-transparent",
                        ].join(" ")}
                        aria-hidden="true"
                      >
                        {checked ? (
                          <Check size={11} strokeWidth={3} className="text-wv-navy" />
                        ) : null}
                      </span>
                      <span className="flex-1 min-w-0 truncate text-wv-fog">
                        {opt.value}
                      </span>
                      {opt.count != null ? (
                        <span className="shrink-0 text-[11px] font-mono text-wv-fog-muted">
                          {opt.count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {active ? (
            <div className="border-t border-wv-navy-3/60 px-3 py-2 flex items-center justify-end">
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-[12px] text-wv-fog-muted hover:text-wv-fog"
              >
                Clear selection
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
