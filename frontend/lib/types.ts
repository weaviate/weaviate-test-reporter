/**
 * TypeScript mirrors of the Weaviate schema in `.project/02-weaviate-schema.md`.
 * Property names match exactly — keep these in lock-step with the action's
 * schema.py and the schema doc.
 */

// The action only ever emits "success" or "failure" today; "cancelled" is
// reserved on the type for a future CI cancellation signal we don't yet
// derive from JUnit XML.
export type TestRunStatus = "success" | "failure" | "cancelled";

export type TestRun = {
  uuid: string;
  run_id: string;
  repository: string;
  branch: string;
  commit_hash: string;
  trigger_type: string;
  status: TestRunStatus;
  total_duration_ms: number;
  timestamp: string;
  workflow_run_id: string;
  workflow_run_attempt: number;
  workflow_name: string;
  job_name: string;
  pr_number: number | null;
  actor: string;
  run_url: string;
  // Version of the artifact under test (e.g. Weaviate). Null when the
  // action was invoked without `version_under_test` or when the value
  // failed semver validation. See `.project/02-weaviate-schema.md` §1.
  version_full: string | null;
  version_minor: string | null;
};

/** Per-minor-version aggregate surfaced by the /versions landing page. */
export type VersionRollup = {
  /** e.g. "1.37" */
  minor: string;
  /** Distinct full versions seen for this minor (e.g. ["1.37.5", "1.37.4"]). */
  fulls: string[];
  /** TestRuns landed for this minor. */
  runs: number;
  /** TestCases landed across those runs. */
  cases: number;
  /** Passed-case ratio in 0..1, or null when no cases ran. */
  passRate: number | null;
};

export type TestCaseStatus = "passed" | "failed" | "skipped";

export type TestCase = {
  uuid: string;
  name: string;
  test_suite: string;
  framework: string;
  status: TestCaseStatus;
  duration_ms: number;
  error_message: string | null;
  stack_trace: string | null;
  failure_type: string | null;
  // Optional reference and similarity metadata, present depending on query.
  belongsToRunUuid?: string;
  distance?: number;
};

export type DashboardKpis = {
  passRate: number; // 0..1
  avgRunDurationMs: number;
  topFailingSuite: { suite: string; count: number } | null;
  totalRuns: number;
  totalCases: number;
};
