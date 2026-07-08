"use client";

/**
 * Subtle freshness note for the cached read views (WS3 R6). The data is
 * memoized server-side (~hourly) and served with stale-while-revalidate, so
 * repeat visits are instant — this tells the reader it may be up to ~an hour
 * stale rather than live.
 */
export function CacheHint() {
  return (
    <span
      data-testid="cache-hint"
      className="inline-flex items-center gap-1.5 text-[11px] text-wv-fog-muted"
      title="Read-only data is cached server-side and refreshes about once an hour."
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full bg-wv-green/50"
      />
      cached · refreshes hourly
    </span>
  );
}
