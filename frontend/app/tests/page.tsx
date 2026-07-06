"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { History } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState } from "@/components/States";
import { TestHistoryView } from "@/components/TestHistoryView";
import { useAsync } from "@/lib/useAsync";
import { fetchTestHistory } from "@/lib/queries";

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
