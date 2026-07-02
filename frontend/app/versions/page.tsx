"use client";

import Link from "next/link";
import {
  CheckCircle2,
  GitBranch,
  Layers,
  ListChecks,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { fetchVersionRollup } from "@/lib/queries";
import { useAsync } from "@/lib/useAsync";
import type { VersionRollup } from "@/lib/types";

/**
 * Versions landing page — answers the question your colleague raised:
 * "how is Weaviate <minor> performing across all our suites?"
 *
 * Each card aggregates every `TestRun` (and its `TestCases`) sharing a
 * `version_minor`. Click-through pre-applies the minor as a filter on
 * the Test Explorer. Older `TestRun` rows that pre-date the version
 * fields (and rows where `version_under_test` was not provided) are
 * grouped under `null` and skipped — by design, since the UX promise is
 * "see how a specific version is doing", not "see runs with no version
 * label."
 */
export default function VersionsPage() {
  const rollup = useAsync(() => fetchVersionRollup(), []);

  return (
    <>
      <PageHeader
        eyebrow="Versions"
        title="By version under test"
        description="Roll-up of every CI run that declared `version_under_test`, grouped by minor version lineage."
      />

      <section className="px-8 py-8">
        {rollup.loading ? (
          <LoadingState label="Aggregating runs per version…" />
        ) : rollup.error ? (
          <ErrorState error={rollup.error} />
        ) : !rollup.data || rollup.data.length === 0 ? (
          <EmptyState
            Icon={GitBranch}
            title="No version-labeled runs yet"
            description="Pass `version_under_test` to weaviate/weaviate-test-reporter to populate this view. Runs without a version aren't shown here on purpose — they're still visible in the Test Explorer."
          />
        ) : (
          <div
            className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="version-grid"
          >
            {rollup.data.map((v, i) => (
              <VersionCard key={v.minor} version={v} delay={i * 50} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function passRateTone(rate: number | null): "good" | "bad" | "neutral" {
  if (rate === null) return "neutral";
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

function formatPct(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function summarizePatches(patches: string[]): string {
  if (patches.length === 0) return "—";
  if (patches.length <= 3) return patches.join(", ");
  return `${patches.slice(0, 3).join(", ")} · +${patches.length - 3} more`;
}

/** Single shared tooltip for the card's headline metric (no duplicated literal). */
const TEST_PASS_RATE_HELP =
  "Share of executed tests that passed (skipped excluded). A finer, less " +
  "flake-sensitive signal than run-level pass rate, where a single failing test " +
  "fails the whole run — see Runs / Passing below for the run-level view.";

function VersionCard({
  version,
  delay,
}: {
  version: VersionRollup;
  delay: number;
}) {
  const tone = passRateTone(version.testPassRate);
  const ToneIcon =
    tone === "good" ? CheckCircle2 : tone === "bad" ? XCircle : ListChecks;
  // Deep-link into the Test Explorer with the minor pre-filtered.
  const href = `/?versionMinor=${encodeURIComponent(version.minor)}`;

  return (
    <Link
      href={href}
      data-testid={`version-card-${version.minor}`}
      style={{ animationDelay: `${delay}ms` }}
      className="
        wv-reveal relative
        rounded-lg border border-wv-navy-3/60
        bg-wv-navy-2/40 backdrop-blur-sm
        p-5 min-h-[170px]
        hover:border-wv-green/50 hover:bg-wv-navy-2/60
        transition-colors
        block group
      "
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-wv-green/40 to-transparent"
      />
      <header className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <GitBranch
            size={16}
            strokeWidth={1.6}
            className="text-wv-fog-muted group-hover:text-wv-green transition-colors"
          />
          <span className="font-display text-3xl tabular-nums text-wv-fog">
            {version.minor}
          </span>
        </div>
        <ToneIcon size={18} strokeWidth={1.6} className={toneAccent(tone)} />
      </header>

      <p
        className="mt-4 text-[11px] uppercase tracking-[0.2em] font-mono text-wv-fog-muted"
        title={TEST_PASS_RATE_HELP}
      >
        Test pass rate
      </p>
      <p
        className={`font-display text-2xl tabular-nums ${toneAccent(tone)}`}
        data-testid={`version-pass-rate-${version.minor}`}
        title={TEST_PASS_RATE_HELP}
      >
        {formatPct(version.testPassRate)}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-y-1 text-[12px] text-wv-fog-muted">
        <dt>Runs</dt>
        <dd className="text-right text-wv-fog tabular-nums">
          {version.runs.toLocaleString()}
        </dd>
        <dt>Passing</dt>
        <dd className="text-right text-wv-fog tabular-nums">
          {version.passingRuns.toLocaleString()}
        </dd>
        <dt>Tests</dt>
        <dd className="text-right text-wv-fog tabular-nums">
          {version.tests.toLocaleString()}
        </dd>
        <dt>Skipped</dt>
        <dd className="text-right text-wv-fog-muted tabular-nums">
          {version.testsSkipped.toLocaleString()}
        </dd>
        <dt>Patches</dt>
        <dd
          className="text-right text-wv-fog tabular-nums"
          title={version.patches.join("\n")}
        >
          {version.patches.length}
        </dd>
      </dl>
      <p className="mt-3 text-[11px] text-wv-fog-muted leading-relaxed font-mono break-words">
        <Layers
          size={12}
          strokeWidth={1.6}
          className="inline-block -mt-0.5 mr-1 text-wv-fog-muted"
        />
        {summarizePatches(version.patches)}
      </p>
    </Link>
  );
}
