"""Parser output types and the text-size cap shared by the core parser and
the dialects."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

MAX_TEXT_BYTES = 32_768
TRUNC_MARKER = "\n[... truncated]"


@dataclass
class ParsedCase:
    name: str
    test_suite: str
    framework: str
    status: str
    duration_ms: int
    error_message: str | None
    stack_trace: str | None
    failure_type: str | None
    # WS1 D3 (retry / rerun capture) — populated per case; dialects without
    # rerun elements degrade to 0 / False / status.
    retry_count: int = 0
    passed_on_retry: bool = False
    initial_status: str = "passed"
    # WS1 D4 (stack-trace fingerprint) — set only for failed cases.
    failure_fingerprint: str | None = None


@dataclass
class RunSummary:
    """Run-level aggregates lifted from the <testsuite> elements themselves.

    Distinct from the per-case stream: `started_at` is the earliest suite
    `timestamp` (WS1 D1) and the `tests_*` counts come from the suite summary
    attributes (WS1 D2). junitparser recomputes the counts from child cases
    when a dialect omits the attributes, so they are always populated.
    """

    started_at: datetime | None = None
    tests_total: int = 0
    tests_failed: int = 0
    tests_errors: int = 0
    tests_skipped: int = 0
    # Run duration. Generic suites: the sum of case durations. Dialect suites:
    # the <testsuite time> (Go parents include their subtests' time, so a case
    # sum double-counts). None when unknown (malformed file); ingest then sums
    # the parsed cases.
    duration_ms: int | None = None


def _truncate(text: str | None) -> str | None:
    if text is None:
        return None
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_TEXT_BYTES:
        return text
    budget = MAX_TEXT_BYTES - len(TRUNC_MARKER.encode("utf-8"))
    return encoded[:budget].decode("utf-8", errors="ignore") + TRUNC_MARKER
