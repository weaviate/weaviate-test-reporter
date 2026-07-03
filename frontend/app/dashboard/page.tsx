"use client";

import { useState } from "react";
import { CheckCircle2, Gauge, Timer, TrendingUp, XCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { TrendCharts } from "@/components/TrendCharts";
import { useAsync } from "@/lib/useAsync";
import { fetchDashboardKpis, fetchRunTrend, isoDaysAgo } from "@/lib/queries";

const RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "all", label: "All time", days: 0 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

function formatDuration(ms: number): string {
  if (!ms) return "0s";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function passRateTone(rate: number): "good" | "bad" | "neutral" {
  if (rate >= 0.95) return "good";
  if (rate >= 0.85) return "neutral";
  return "bad";
}

function toneAccent(tone: "good" | "bad" | "neutral"): string {
  switch (tone) {
    case "good":
      return "text-wv-green";
    case "bad":
      return "text-wv-danger";
    default:
      return "text-wv-fog-muted";
  }
}

export default function DashboardPage() {
  const [rangeId, setRangeId] = useState<RangeId>("7d");
  const range = RANGES.find((r) => r.id === rangeId)!;
  const sinceIso = range.days > 0 ? isoDaysAgo(range.days) : undefined;

  const kpis = useAsync(
    () => fetchDashboardKpis(sinceIso),
    [sinceIso ?? "all"],
  );
  const trend = useAsync(() => fetchRunTrend(sinceIso), [sinceIso ?? "all"]);

  return (
    <>
      <PageHeader
        eyebrow="Metrics Dashboard"
        title="State of the suite"
        description="KPIs computed via Weaviate aggregation queries."
        right={
          <div
            className="inline-flex rounded-md border border-wv-navy-3/60 overflow-hidden"
            data-testid="range-picker"
          >
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRangeId(r.id)}
                aria-pressed={rangeId === r.id}
                className={[
                  "px-3 py-1.5 text-sm transition-colors",
                  rangeId === r.id
                    ? "bg-wv-green/10 text-wv-fog"
                    : "text-wv-fog-muted hover:text-wv-fog hover:bg-wv-navy-2",
                ].join(" ")}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      <section className="px-8 py-8 space-y-8">
        {kpis.loading ? (
          <LoadingState label="Aggregating Weaviate metrics…" />
        ) : kpis.error ? (
          <ErrorState error={kpis.error} />
        ) : kpis.data ? (
          <>
            <div className="grid gap-5 sm:grid-cols-3">
              <KpiCard
                testId="kpi-pass-rate"
                label="Global pass rate"
                value={formatPct(kpis.data.passRate)}
                helper={`Across ${kpis.data.totalCases.toLocaleString()} TestCases.`}
                Icon={CheckCircle2}
                tone={passRateTone(kpis.data.passRate)}
                delay={0}
              />
              <KpiCard
                testId="kpi-avg-duration"
                label="Avg run duration"
                value={formatDuration(kpis.data.avgRunDurationMs)}
                helper={`Mean of total_duration_ms across ${kpis.data.totalRuns} TestRuns.`}
                Icon={Timer}
                tone="neutral"
                delay={60}
              />
              <KpiCard
                testId="kpi-top-failing-suite"
                label="Top failing suite"
                value={
                  kpis.data.topFailingSuite
                    ? `${kpis.data.topFailingSuite.count}`
                    : "0"
                }
                helper={
                  kpis.data.topFailingSuite
                    ? kpis.data.topFailingSuite.suite
                    : "No failures across recent runs — clean sweep."
                }
                Icon={XCircle}
                tone={kpis.data.topFailingSuite ? "bad" : "good"}
                delay={120}
              />
            </div>
          </>
        ) : null}

        {trend.loading ? (
          <LoadingState label="Charting run history…" />
        ) : trend.error ? (
          <ErrorState error={trend.error} />
        ) : trend.data && trend.data.length > 0 ? (
          <TrendCharts data={trend.data} />
        ) : trend.data ? (
          <EmptyState
            Icon={TrendingUp}
            title="Not enough history to chart yet"
            description="Trends appear once runs have landed in this window — widen the range or ingest more runs."
          />
        ) : null}
      </section>
    </>
  );
}

function KpiCard({
  label,
  value,
  helper,
  Icon,
  tone,
  delay,
  testId,
}: {
  label: string;
  value: string;
  helper: string;
  Icon: typeof Gauge;
  tone: "good" | "bad" | "neutral";
  delay: number;
  testId?: string;
}) {
  return (
    <article
      data-testid={testId}
      className="
        wv-reveal relative
        rounded-lg border border-wv-navy-3/60
        bg-wv-navy-2/40 backdrop-blur-sm
        p-5 min-h-[160px]
        hover:border-wv-navy-3
        transition-colors
      "
      style={{ animationDelay: `${delay}ms` }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-wv-green/40 to-transparent"
      />
      <header className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
          {label}
        </p>
        <Icon size={18} strokeWidth={1.6} className={toneAccent(tone)} />
      </header>
      <p className="font-display text-4xl mt-3 tabular-nums text-wv-fog">
        {value}
      </p>
      <p className="mt-2 text-[12px] text-wv-fog-muted leading-relaxed break-words">
        {helper}
      </p>
    </article>
  );
}
