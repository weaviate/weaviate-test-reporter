"""The contract a JUnit dialect implements.

A dialect handles one producer's quirks (e.g. gotestsum) on top of the generic
parsing in `core`. Core picks the first registered dialect whose `matches`
accepts a <testsuite>, stores `framework` on that suite's cases, and passes
the parsed cases through `postprocess`. When a dialect handled a suite, the
run-level counts come from the cases `postprocess` returned, so they always
agree with the stored TestCase rows.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from junitparser import TestSuite

from ..models import ParsedCase


@dataclass(frozen=True)
class Dialect:
    # Value stored as TestCase.framework for every case of a matched suite.
    framework: str
    # True when the suite was written by this producer. Use a structural
    # marker the producer always writes (a property, an attribute), not a
    # guess from test or class names.
    matches: Callable[[TestSuite], bool]
    # Fix up one suite's cases: rewrite fields, drop or merge cases. Must not
    # raise on unexpected input; return the cases unchanged instead.
    postprocess: Callable[[list[ParsedCase]], list[ParsedCase]]
