"""Contract between the core parser and dialects, tested with a stub dialect
so it does not depend on any real producer's rules."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from weaviate_test_reporter.parser import dialects, parse_junit_file, parse_junit_summary
from weaviate_test_reporter.parser.dialects.base import Dialect

XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="stub-suite" tests="3" failures="2">
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
