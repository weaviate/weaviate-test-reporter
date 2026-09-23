"""Failure fingerprint: a stable hash of a normalized stack trace (WS1 D4)."""

from __future__ import annotations

import hashlib
import re

_FINGERPRINT_LEN = 16


# WS1 D4: stack-trace fingerprint.
#
# We hash a NORMALIZED trace so that two failures that differ only in volatile
# tokens (line numbers, memory addresses, timestamps, temp paths, long id
# runs) collapse to the same key — the exact-match dedup used by R4 — while
# genuinely different error shapes (types, messages, file names) stay distinct.
# Order matters: strip whole ISO timestamps, temp-path tokens and UUIDs BEFORE
# the generic `:<line>` / long-digit passes so their internal digits aren't
# rewritten piecemeal.
_ISO_TIMESTAMP_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"
)
# OS temp directories contain random per-run subpaths (build dirs, pytest
# tmpdirs), so the whole token is volatile — redact it entirely.
_OS_TEMP_RE = re.compile(r"(?:/tmp/|/var/folders/|/private/)\S*")
# CI runner CHECKOUT PREFIX only: GitHub-hosted `/home/runner/work/{repo}/{repo}/`,
# self-hosted `/home/actions-runner/_work/{repo}/{repo}/`, legacy
# `/runner/_work/{repo}/{repo}/`. Strip just this prefix so the same failure
# fingerprints identically across runner types, while KEEPING the repo-relative
# path that follows — the file is part of the failure's identity, so distinct
# files must stay distinct (only the volatile checkout root is noise).
_RUNNER_PREFIX_RE = re.compile(
    r"(?:/home/runner/work|/home/actions-runner/_work|/runner/_work)/[^/\s]+/[^/\s]+/"
)
# Go/gotestsum elapsed-time suffix, e.g. `(0.08s)`, `(200ms)`, `(3µs)`. The
# duration varies run-to-run and must not fragment the fingerprint. Stripped
# BEFORE the long-digit pass so millisecond/nanosecond magnitudes collapse too.
_GO_DURATION_RE = re.compile(r"\(\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h)\)")
_HEX_ADDR_RE = re.compile(r"0x[0-9a-fA-F]+")
# Object/tenant/backup UUIDs are per-run identity, never failure shape. Hex
# segments with letters dodge the digit passes, so without this a message like
# "Vector mismatch for <uuid> on node weaviate-0" hashed uniquely per object
# and R4 saw N singletons instead of one mass-failure cluster.
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}" r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
# StatefulSet/pod ordinals (`weaviate-0`, `shard-1-of-2`): which replica a
# failure hit is volatile, not shape. Bare small numbers (HTTP 422, counts)
# are NOT touched — only 1-3 digits directly after a `letter-` prefix. Known
# trade-off: numbered file/dataset tokens (`data-1.json`, `top-10`) merge too
# — a deliberate exception to the keep-files-distinct rule above, since such
# names are usually shard artifacts of one failure, not distinct causes.
_HOST_ORDINAL_RE = re.compile(r"(?<=[A-Za-z])-\d{1,3}\b")
_LINE_WORD_RE = re.compile(r"\bline\s+\d+", re.IGNORECASE)
_COLON_LINE_RE = re.compile(r":\d+")
_LONG_DIGITS_RE = re.compile(r"\d{4,}")
_WS_RE = re.compile(r"\s+")


def normalize_stack_trace(text: str) -> str:
    """Strip volatile tokens from a stack trace so equivalent failures hash
    identically. Pure function — unit-tested directly."""
    s = _ISO_TIMESTAMP_RE.sub("<TS>", text)
    s = _OS_TEMP_RE.sub("<PATH>", s)
    # Strip only the volatile runner checkout prefix; keep the repo-relative path.
    s = _RUNNER_PREFIX_RE.sub("", s)
    s = _GO_DURATION_RE.sub("(<DUR>)", s)
    s = _HEX_ADDR_RE.sub("<HEX>", s)
    # UUIDs before the ordinal/digit passes: their pure-digit segments (e.g.
    # `-0001-`) must vanish as part of the whole token, not piecemeal. Both
    # tokens require a `-`, so dash-free text (common in large plain-assert
    # payloads) skips both scans — they cost ~30% of this function otherwise,
    # enough to blow the 5s large-file CI budget.
    if "-" in s:
        s = _UUID_RE.sub("<UUID>", s)
        s = _HOST_ORDINAL_RE.sub("-<N>", s)
    s = _LINE_WORD_RE.sub("line <N>", s)
    s = _COLON_LINE_RE.sub(":<N>", s)
    s = _LONG_DIGITS_RE.sub("<NUM>", s)
    return _WS_RE.sub(" ", s).strip()


def stack_trace_fingerprint(text: str | None) -> str | None:
    """Stable 16-char sha256 of the normalized trace; None for empty input."""
    if text is None or not text.strip():
        return None
    normalized = normalize_stack_trace(text)
    digest = hashlib.sha256(normalized.encode("utf-8", errors="replace")).hexdigest()
    return digest[:_FINGERPRINT_LEN]
