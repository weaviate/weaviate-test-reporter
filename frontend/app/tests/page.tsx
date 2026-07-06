"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { TestHistoryView } from "@/components/TestHistoryView";
import { useAsync } from "@/lib/useAsync";
import { fetchTestHistory } from "@/lib/queries";

// Known deep-link origins → the "← Back to …" target. An unknown or
// directly-opened URL falls back to the Test Explorer.
const BACK_SOURCES: Record<string, { label: string; href: string }> = {
  flakes: { label: "Flakes", href: "/flakes" },
  explorer: { label: "Test Explorer", href: "/" },
};
const DEFAULT_BACK = { label: "Test Explorer", href: "/" };

export default function TestHistoryPage() {
  // useSearchParams needs a Suspense boundary (params are request-time only).
  return (
    <Suspense fallback={<LoadingState label="Loading test…" />}>
      <TestHistoryBody />
    </Suspense>
  );
}

function TestHistoryBody() {
  const params = useSearchParams();
  const suite = params.get("suite") ?? "";
  const name = params.get("name") ?? "";
  const enabled = Boolean(suite && name);

  // "← Back to …" target, keyed on the deep-link's `from` marker.
  const back = BACK_SOURCES[params.get("from") ?? ""] ?? DEFAULT_BACK;

  const history = useAsync(
    () => (enabled ? fetchTestHistory(suite, name) : Promise.resolve(null)),
    [suite, name],
  );

  if (!enabled) {
    return (
      <>
        <PageHeader
          eyebrow="Test history"
          title="Single-test history"
          description="A test's pass/fail timeline across every run, branch, and version."
        />
        <section className="px-8 py-8">
          <EmptyState
            Icon={History}
            title="No test selected"
            description="Open a test's history from the Flakes page or from a failed case in the Test Explorer."
          />
        </section>
      </>
    );
  }

  return (
    <>
      <div className="px-8 pt-6">
        <Link
          href={back.href}
          className="inline-flex items-center gap-1.5 text-[13px] text-wv-fog-muted hover:text-wv-fog transition-colors"
          data-testid="test-history-back"
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
          Back to {back.label}
        </Link>
      </div>
      <PageHeader eyebrow="Test history" title={name} description={suite} />
      <section className="px-8 py-8">
        {history.loading ? (
          <LoadingState label="Loading history…" />
        ) : history.error ? (
          <ErrorState error={history.error} />
        ) : history.data ? (
          <TestHistoryView history={history.data} />
        ) : null}
      </section>
    </>
  );
}
