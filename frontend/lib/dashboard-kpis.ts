export function topFailingSuiteCard(kpis: {
  topFailingSuite: { suite: string; count: number } | null;
  infraFailureRuns: number;
}) {
  if (kpis.topFailingSuite) {
    return {
      value: `${kpis.topFailingSuite.count}`,
      helper: kpis.topFailingSuite.suite,
      tone: "bad" as const,
    };
  }
  if (kpis.infraFailureRuns > 0) {
    const runLabel = kpis.infraFailureRuns === 1 ? "TestRun" : "TestRuns";
    return {
      value: "0",
      helper: `No failed TestCases were reported; ${kpis.infraFailureRuns} ${runLabel} infra-failed before tests started.`,
      tone: "neutral" as const,
    };
  }
  return {
    value: "0",
    helper: "No failures across recent runs — clean sweep.",
    tone: "good" as const,
  };
}
