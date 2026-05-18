"""Structured logging with GitHub Actions integration.

Two renderers selected by the GITHUB_ACTIONS env var (Actions sets this
to "true" inside any workflow run):

- GitHub Actions -> JSON renderer. Each log line is machine-parseable;
  this makes correlating CI logs with Weaviate server-side traces during
  triage straightforward.
- Local dev -> ConsoleRenderer (colorized, human-readable).

The group() context manager emits the `::group::name` / `::endgroup::`
markers GitHub Actions uses to render collapsible sections in the run
log. Outside Actions it's a no-op, so the same code path is valid for
local debugging.
"""

from __future__ import annotations

import logging as stdlib_logging
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager

import structlog


def _in_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def configure_logging(level: int = stdlib_logging.INFO) -> None:
    """Idempotent: safe to call multiple times (e.g., from tests)."""
    if _in_github_actions():
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=False)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=False,  # tests reconfigure; don't cache
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


@contextmanager
def group(name: str) -> Iterator[None]:
    """Emit `::group::name` / `::endgroup::` markers around the body when
    running in GitHub Actions; no-op otherwise.

    The endgroup is always emitted (try/finally) so a raising body does
    not leave the GitHub Actions log permanently collapsed.
    """
    in_actions = _in_github_actions()
    if in_actions:
        print(f"::group::{name}", flush=True)
    try:
        yield
    finally:
        if in_actions:
            print("::endgroup::", flush=True)
        sys.stdout.flush()
