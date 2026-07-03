"use client";

import type { ReactElement } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type { TrendPoint } from "@/lib/queries";
import { passRateDomain } from "@/lib/analysis";

// Recharts takes plain CSS color strings; reference the brand tokens so the
// charts stay in lock-step with the theme (globals.css `:root`).
const AXIS = "var(--wv-fog-muted)";
const GRID = "var(--wv-navy-3)";

const TOOLTIP_STYLE = {
  background: "var(--wv-navy-2)",
  border: "1px solid var(--wv-navy-3)",
  borderRadius: 8,
  color: "var(--wv-fog)",
  fontSize: 12,
} as const;

/** "2026-07-01" → "07-01" (compact axis tick; days are already UTC). */
const dayTick = (day: string): string => day.slice(5);
// Whole-percent for the axis gridlines; one decimal for the tooltip value so a
// 99.8% (or a drop to 99.5%) isn't rounded up to a flat "100%".
const pctTick = (v: number): string => `${Math.round(v * 100)}%`;
const pctPrecise = (v: number): string => `${(v * 100).toFixed(1)}%`;
const durationTick = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

function ChartCard({
  title,
  subtitle,
  testId,
  children,
}: {
  title: string;
  subtitle: string;
  testId: string;
  children: ReactElement;
}) {
  return (
    <article
      data-testid={testId}
      className="rounded-lg border border-wv-navy-3/60 bg-wv-navy-2/40 backdrop-blur-sm p-5"
    >
      <header className="mb-4">
        <p className="text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted">
          {title}
        </p>
        <p className="mt-1 text-[12px] text-wv-fog-muted">{subtitle}</p>
      </header>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </article>
  );
}

const CHART_MARGIN = { top: 4, right: 8, bottom: 0, left: -12 } as const;
const xAxisProps = {
  dataKey: "day",
  tickFormatter: dayTick,
  tick: { fill: AXIS, fontSize: 11 },
  stroke: GRID,
  interval: "preserveStartEnd" as const,
  minTickGap: 24,
};
const yAxisBase = {
  tick: { fill: AXIS, fontSize: 11 },
  stroke: GRID,
  width: 40,
};

/**
 * The three WS2 H2 trend charts, driven by the per-day `TrendPoint[]` series.
 * A dumb visual layer — the parent fetches and handles loading/empty states.
 */
export function TrendCharts({ data }: { data: TrendPoint[] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-3" data-testid="trend-charts">
      <ChartCard
        title="Pass rate"
        subtitle="Test-level, per day"
        testId="trend-chart-pass-rate"
      >
        <AreaChart data={data} margin={CHART_MARGIN}>
          <defs>
            <linearGradient id="passFill" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--wv-green)"
                stopOpacity={0.35}
              />
              <stop offset="100%" stopColor="var(--wv-green)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} strokeOpacity={0.4} vertical={false} />
          <XAxis {...xAxisProps} />
          <YAxis
            {...yAxisBase}
            domain={passRateDomain(data)}
            tickFormatter={pctTick}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: "var(--wv-fog-muted)" }}
            formatter={(value) => [
              value == null ? "N/A" : pctPrecise(Number(value)),
              "pass rate",
            ]}
          />
          <Area
            type="monotone"
            dataKey="passRate"
            stroke="var(--wv-green)"
            strokeWidth={2}
            fill="url(#passFill)"
            connectNulls={false}
            dot={false}
          />
        </AreaChart>
      </ChartCard>

      <ChartCard
        title="Failures"
        subtitle="Failed + errored tests per day"
        testId="trend-chart-failures"
      >
        <BarChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid stroke={GRID} strokeOpacity={0.4} vertical={false} />
          <XAxis {...xAxisProps} />
          <YAxis {...yAxisBase} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--wv-navy-3)", fillOpacity: 0.3 }}
            formatter={(value) => [Number(value), "failures"]}
          />
          <Bar
            dataKey="failures"
            fill="var(--wv-danger)"
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ChartCard>

      <ChartCard
        title="Avg run duration"
        subtitle="Mean total_duration per day"
        testId="trend-chart-duration"
      >
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid stroke={GRID} strokeOpacity={0.4} vertical={false} />
          <XAxis {...xAxisProps} />
          <YAxis {...yAxisBase} tickFormatter={durationTick} width={44} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value) => [durationTick(Number(value)), "avg duration"]}
          />
          <Line
            type="monotone"
            dataKey="avgDurationMs"
            stroke="var(--wv-fog-muted)"
            strokeWidth={2}
            connectNulls
            dot={false}
          />
        </LineChart>
      </ChartCard>
    </div>
  );
}
