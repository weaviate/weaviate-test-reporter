"use client";

import { useState } from "react";
import { Search, Sparkles, SearchCode, ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { useAsync } from "@/lib/useAsync";
import {
  DEFAULT_TARGET_VECTOR,
  TARGET_VECTORS,
  semanticSearch,
  type TargetVector,
} from "@/lib/queries";

const EXAMPLE = `Traceback (most recent call last):
  File "backup.py", line 42, in restore
    assert snapshot.exists()
AssertionError: expected snapshot to exist`;

const TARGET_LABELS: Record<TargetVector, string> = {
  stack_trace: "Stack trace",
  error_message: "Error message",
  name: "Test name",
};

function similarity(distance: number | undefined): string {
  if (distance == null) return "—";
  return `${Math.max(0, 100 - distance * 100).toFixed(1)}%`;
}

export default function SemanticSearchPage() {
  const [draft, setDraft] = useState(EXAMPLE);
  const [submitted, setSubmitted] = useState<string>("");
  const [target, setTarget] = useState<TargetVector>(DEFAULT_TARGET_VECTOR);

  const results = useAsync(
    () => semanticSearch(submitted, { limit: 20, failedOnly: true, targetVector: target }),
    [submitted, target]
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(draft.trim());
  }

  return (
    <>
      <PageHeader
        eyebrow="Semantic Search"
        title="Find tests that failed like this one"
        description="Paste a stack trace or error excerpt. Vector similarity ranks the closest historical failures."
      />

      <section className="px-8 py-8 wv-reveal" style={{ animationDelay: "80ms" }}>
        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 backdrop-blur-sm p-5"
        >
          <label
            htmlFor="q"
            className="block text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted mb-3"
          >
            Paste an error · stack trace · message
          </label>
          <textarea
            id="q"
            rows={6}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="search-textarea"
            className="
              w-full font-mono text-[13px] leading-relaxed
              bg-wv-ink/60 text-wv-fog placeholder:text-wv-fog-muted/50
              border border-wv-navy-3/60 rounded-md
              px-4 py-3 resize-y
              focus:border-wv-green/50
            "
          />
          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <p className="text-[12px] text-wv-fog-muted">
                Filtered to <span className="text-wv-fog">status = failed</span>.
              </p>
              <TargetVectorPicker target={target} onChange={setTarget} />
            </div>
            <button
              type="submit"
              disabled={!draft.trim()}
              data-testid="search-submit"
              className="
                inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm
                bg-wv-green text-wv-navy font-medium
                hover:bg-wv-green-hi
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-colors
              "
            >
              <Sparkles size={14} strokeWidth={2} />
              Search
            </button>
          </div>
        </form>

        <div className="mt-8">
          {!submitted ? (
            <EmptyState
              Icon={SearchCode}
              title="Run a query above."
              description="Or visit Test Explorer first to see what data has been ingested."
            />
          ) : results.loading ? (
            <LoadingState label={`Vectorizing query · matching against ${TARGET_LABELS[target].toLowerCase()}…`} />
          ) : results.error ? (
            <ErrorState error={results.error} />
          ) : results.data && results.data.length > 0 ? (
            <ul className="space-y-3" data-testid="search-results">
              {results.data.map((c, idx) => (
                <li
                  key={c.uuid}
                  data-testid="search-result"
                  className="
                    wv-reveal rounded-lg border border-wv-navy-3/60
                    bg-wv-navy-2/40 backdrop-blur-sm p-4
                  "
                  style={{ animationDelay: `${idx * 25}ms` }}
                >
                  <div className="flex items-start gap-4">
                    <div className="
                      shrink-0 w-16 text-center
                      px-2 py-2 rounded-md
                      bg-wv-green/10 border border-wv-green/30
                    ">
                      <p className="font-mono text-[16px] text-wv-green tabular-nums leading-tight">
                        {similarity(c.distance).replace("%", "")}
                      </p>
                      <p className="text-[10px] uppercase tracking-wider text-wv-green/70 font-mono mt-0.5">
                        match
                      </p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3 flex-wrap mb-1.5">
                        <p className="font-mono text-[13px] text-wv-fog truncate">
                          {c.name}
                        </p>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] font-mono text-wv-fog-muted">
                            {c.test_suite}
                          </span>
                          <StatusBadge status={c.status} />
                        </div>
                      </div>
                      {c.failure_type ? (
                        <p className="text-[12px] text-wv-danger font-mono mb-1">
                          {c.failure_type}
                        </p>
                      ) : null}
                      {c.error_message ? (
                        <p className="text-[13px] text-wv-fog/90 leading-relaxed">
                          {c.error_message}
                        </p>
                      ) : null}
                      {c.stack_trace ? (
                        <pre className="mt-2 font-mono text-[11px] leading-relaxed text-wv-fog-muted whitespace-pre-wrap max-h-32 overflow-y-auto">
                          {c.stack_trace}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              Icon={SearchCode}
              title="No matching failures."
              description="Try a broader description of the failure, or pick a different target vector."
            />
          )}
        </div>
      </section>
    </>
  );
}

function TargetVectorPicker({
  target,
  onChange,
}: {
  target: TargetVector;
  onChange: (next: TargetVector) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-wv-fog-muted">
      <Search size={13} strokeWidth={1.75} />
      <span>Search against</span>
      <span className="relative">
        <select
          value={target}
          onChange={(e) => onChange(e.target.value as TargetVector)}
          data-testid="target-vector-picker"
          className="
            appearance-none bg-wv-navy-2 text-wv-fog
            border border-wv-navy-3/60 rounded-md
            px-2.5 py-1 pr-7 text-[12px]
            hover:border-wv-navy-3 focus:border-wv-green/50
          "
        >
          {TARGET_VECTORS.map((v) => (
            <option key={v} value={v}>
              {TARGET_LABELS[v]}
            </option>
          ))}
        </select>
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-wv-fog-muted pointer-events-none"
        />
      </span>
    </label>
  );
}
