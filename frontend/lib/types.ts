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
