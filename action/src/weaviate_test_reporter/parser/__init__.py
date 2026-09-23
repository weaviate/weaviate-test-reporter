"""JUnit XML -> ParsedCase dataclasses.

`core` parses standard JUnit; `fingerprint` hashes failure traces; `models`
holds the output types. Import from this package, not from the submodules.
"""

from .core import merge_summaries, parse_junit_file, parse_junit_summary
from .fingerprint import normalize_stack_trace, stack_trace_fingerprint
from .models import MAX_TEXT_BYTES, TRUNC_MARKER, ParsedCase, RunSummary

__all__ = [
    "MAX_TEXT_BYTES",
    "TRUNC_MARKER",
    "ParsedCase",
    "RunSummary",
    "merge_summaries",
    "normalize_stack_trace",
    "parse_junit_file",
    "parse_junit_summary",
    "stack_trace_fingerprint",
]
