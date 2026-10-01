"""Contract between the core parser and dialects, tested with a stub dialect
so it does not depend on any real producer's rules."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from structlog.testing import capture_logs

from weaviate_test_reporter.parser import (
    dialects,
    parse_junit,
    parse_junit_file,
    parse_junit_summary,
)
from weaviate_test_reporter.parser.dialects.base import Dialect

XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="stub-suite" tests="3" failures="2" time="7.5">
    <testcase classname="pkg.mod" name="test_a" time="0.1"/>
    <testcase classname="pkg.mod" name="test_b" time="0.1">
      <failure message="boom">trace</failure>
    </testcase>
    <testcase classname="pkg.mod" name="test_c" time="0.1">
      <failure message="boom">trace</failure>
    </testcase>
  </testsuite>
  <testsuite name="other-suite" tests="1" failures="0">
    <testcase classname="tests.other" name="test_x" time="0.1"/>
  </testsuite>
</testsuites>
"""


def _drop_c(cases):
    return [replace(c, error_message="rewritten") for c in cases if c.name != "test_c"]


STUB = Dialect(framework="stub", matches=lambda s: s.name == "stub-suite", postprocess=_drop_c)


@pytest.fixture
def xml_file(tmp_path: Path) -> Path:
    p = tmp_path / "junit.xml"
    p.write_text(XML)
    return p


def _use(monkeypatch, *registered: Dialect) -> None:
    monkeypatch.setattr(dialects, "DIALECTS", registered)


def test_matched_suite_gets_dialect_framework_and_postprocess(monkeypatch, xml_file):
    _use(monkeypatch, STUB)
    cases = {c.name: c for c in parse_junit_file(xml_file)}
    assert "test_c" not in cases
    assert cases["test_b"].framework == "stub"
    assert cases["test_b"].error_message == "rewritten"


def test_unmatched_suite_uses_generic_parsing(monkeypatch, xml_file):
    _use(monkeypatch, STUB)
    other = next(c for c in parse_junit_file(xml_file) if c.name == "test_x")
    assert other.framework == "pytest"
    assert other.error_message is None


def test_counts_for_matched_suite_come_from_kept_cases(monkeypatch, xml_file):
    _use(monkeypatch, STUB)
    s = parse_junit_summary(xml_file)
    # stub-suite: 2 kept (1 failed); other-suite: attributes (1 test, 0 failed).
    assert (s.tests_total, s.tests_failed) == (3, 1)


def test_first_matching_dialect_wins(monkeypatch, xml_file):
    second = Dialect(framework="second", matches=lambda s: True, postprocess=lambda c: c)
    _use(monkeypatch, STUB, second)
    frameworks = {c.name: c.framework for c in parse_junit_file(xml_file)}
    assert frameworks["test_a"] == "stub"
    assert frameworks["test_x"] == "second"


def test_raising_postprocess_keeps_generic_cases(monkeypatch, xml_file):
    def boom(cases):
        raise RuntimeError("dialect bug")

    _use(monkeypatch, Dialect(framework="stub", matches=lambda s: True, postprocess=boom))
    cases = list(parse_junit_file(xml_file))
    assert len(cases) == 4
    assert parse_junit_summary(xml_file).tests_total == 4


def test_raising_matches_is_no_match(monkeypatch, xml_file):
    def boom(suite):
        raise RuntimeError("dialect bug")

    _use(monkeypatch)
    generic = list(parse_junit_file(xml_file))
    _use(monkeypatch, Dialect(framework="stub", matches=boom, postprocess=lambda c: c))
    assert list(parse_junit_file(xml_file)) == generic


def test_no_dialects_registered_matches_generic_behavior(monkeypatch, xml_file):
    _use(monkeypatch)
    s = parse_junit_summary(xml_file)
    assert (s.tests_total, s.tests_failed) == (4, 2)
    assert len(list(parse_junit_file(xml_file))) == 4


def test_duration_for_matched_suite_is_suite_time(monkeypatch, xml_file):
    _use(monkeypatch, STUB)
    # stub-suite: time="7.5" -> 7500 ms; other-suite: case sum 100 ms.
    assert parse_junit_summary(xml_file).duration_ms == 7_600


def test_raising_dialect_is_logged(monkeypatch, xml_file):
    """A broken dialect falls back to generic parsing; the action log must say
    so, or Go data silently loses its fix-ups."""

    def boom(cases):
        raise RuntimeError("dialect bug")

    _use(monkeypatch, Dialect(framework="stub", matches=lambda s: True, postprocess=boom))
    with capture_logs() as logs:
        list(parse_junit_file(xml_file))
    events = [e for e in logs if e["event"] == "dialect_postprocess_failed"]
    assert events and events[0]["framework"] == "stub" and "dialect bug" in events[0]["error"]


def test_raising_matches_is_logged(monkeypatch, xml_file):
    def boom(suite):
        raise RuntimeError("matches bug")

    _use(monkeypatch, Dialect(framework="stub", matches=boom, postprocess=lambda c: c))
    with capture_logs() as logs:
        list(parse_junit_file(xml_file))
    assert any(e["event"] == "dialect_match_failed" for e in logs)


def test_raising_postprocess_summary_follows_the_generic_path(monkeypatch, tmp_path):
    """When the dialect fails, the cases fall back to generic parsing and so
    must the counts and duration: from the suite attributes, not the case list."""
    xml = tmp_path / "junit.xml"
    xml.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<testsuites><testsuite name="s" tests="5" failures="2" time="9.0">\n'
        '  <testcase classname="pkg.mod" name="test_a" time="0.1"/>\n'
        '  <testcase classname="pkg.mod" name="test_b" time="0.2">'
        '<failure message="boom">trace</failure></testcase>\n'
        '  <testcase classname="pkg.mod" name="test_c" time="0.3"/>\n'
        "</testsuite></testsuites>\n"
    )
    _use(monkeypatch)
    generic = parse_junit_summary(xml)
    assert (generic.tests_total, generic.tests_failed) == (5, 2)

    def boom(cases):
        raise RuntimeError("dialect bug")

    _use(monkeypatch, Dialect(framework="stub", matches=lambda s: True, postprocess=boom))
    assert parse_junit_summary(xml) == generic
    cases, summary = parse_junit(xml)
    assert summary == generic
    assert len(cases) == 3
