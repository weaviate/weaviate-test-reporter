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
  /** Deep-link to this run's specific CI job (WS1 D5). Falls back to the
   *  run+attempt page (run_url) when the per-job URL can't be resolved. */
  job_url: string;
  // Three version slots, all derived from a single `version_under_test`
  // action input via SemVer 2.0 parsing. All three are null when the
  // action was invoked without `version_under_test` — a non-empty
  // invalid value now causes the action to fail at config-load, so
  // these properties are either all populated or all null.
  // See `.project/02-weaviate-schema.md` §1 for the property contract.
  //
  // version_full  — verbatim build-unique identifier (e.g.
  //                 `1.38.1-rfea1de`). Primary key for dedup queries.
  // version_patch — canonical `MAJOR.MINOR.PATCH` with pre-release
  //                 dropped (e.g. `1.38.1`). Per-release grouping.
  // version_minor — `MAJOR.MINOR` lineage (e.g. `1.38`). The
  //                 dashboard's primary grouping key on /versions.
  version_full: string | null;
  version_patch: string | null;
  version_minor: string | null;
};

/** Per-minor-version aggregate surfaced by the /versions landing page. */
export type VersionRollup = {
  /** e.g. "1.37" */
  minor: string;
  /** Distinct canonical release versions seen for this minor — drawn
   *  from `version_patch`, NOT `version_full`. Pre-release / build-hash
   *  suffixes are folded back to the canonical release, so e.g.
   *  `1.38.0-dev-9479337` and `1.38.0-dev-aaaaaaa` both surface here
   *  as `1.38.0` (giving the user a clean "what patches did we test
   *  on this minor" view). The build-unique form is still available
   *  on the underlying TestRun for dedup queries. */
  patches: string[];
  /** TestRuns landed for this minor. */
  runs: number;
  /** TestRuns where status == "success". */
  passingRuns: number;
  /** passingRuns / runs in 0..1, or null when no runs landed. */
  passRate: number | null;
  /** Total test cases executed across this minor's runs (Σ TestRun.tests_total). */
  tests: number;
  /** Passing test cases across this minor's runs (Σ TestRun.tests_passed). */
  testsPassed: number;
  /** testsPassed / tests in 0..1, or null when no test cases were recorded. */
  testPassRate: number | null;
};

/** Filter set for the Test Explorer run list. Empty/undefined fields mean
 *  "no filter on that dimension". */
export type RunFilters = {
  /** Free-text fragment matched (case-insensitive) against run_id, branch,
   *  actor, commit_hash. */
  search?: string;
  /** Repository property — multi-select. */
  repositories?: string[];
  /** Status property — multi-select. */
  statuses?: string[];
  /** Minor version (e.g. "1.37") — multi-select. */
  versionMinors?: string[];
  /** Full version (e.g. "1.37.5") — multi-select. */
  versionFulls?: string[];
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

/**
 * A test that flips between passed/failed over the analysis window.
 *
 * `flakiness_score` is `transitions / (total_runs - 1)`, clamped to
 * `[0, 1]`. A score of 0 means the test is stable (all passed or all
 * failed throughout); 0.5 means it flips state on every run; 1 means
 * it flips on EVERY transition (perfect noise).
 *
 * `recent_statuses` is the chronological status sequence used for the
 * "last N" pixel strip in the UI — oldest first.
 */
export type FlakyTest = {
  test_suite: string;
  name: string;
  framework: string;
  total_runs: number;
  passed: number;
  failed: number;
  transitions: number;
  flakiness_score: number;
  recent_statuses: TestCaseStatus[];
};
