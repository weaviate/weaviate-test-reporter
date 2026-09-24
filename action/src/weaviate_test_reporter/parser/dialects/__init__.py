"""Registered JUnit dialects, tried in order. See `base.Dialect`.

To add one: create `dialects/<producer>.py` exposing `DIALECT`, add it to
`DIALECTS`, and add tests with fixtures copied from real CI output.
"""

from __future__ import annotations

from junitparser import TestSuite

from . import gotestsum
from .base import Dialect

DIALECTS: tuple[Dialect, ...] = (gotestsum.DIALECT,)


def select_dialect(suite: TestSuite) -> Dialect | None:
    """First dialect whose `matches` accepts the suite; None means generic
    parsing only. A dialect whose `matches` raises is treated as no match."""
    for dialect in DIALECTS:
        try:
            if dialect.matches(suite):
                return dialect
        except Exception:
            continue
    return None
