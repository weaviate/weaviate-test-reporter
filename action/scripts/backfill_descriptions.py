"""Backfill collection + property descriptions onto an EXISTING cluster.

`schema.py` only sets descriptions when a collection/property is first created.
Collections created before descriptions were added (or by an older action) keep
`description=null`, which starves the Weaviate Query Agent of the context it
needs to pick the right collection/property to filter and aggregate on.

This one-off utility reads the canonical descriptions from `schema.py` and
applies them in place via the schema-update REST API (`PUT /v1/schema/{class}`).
It is metadata-only: no re-index, no data loss. Idempotent — safe to re-run.

Env: WEAVIATE_URL, WEAVIATE_API_KEY (a key with schema-write permission).
Run:  PYTHONPATH=action/src python3 action/scripts/backfill_descriptions.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from weaviate_test_reporter.schema import (  # noqa: E402
    TEST_CASE,
    TEST_RUN,
    _BELONGS_TO_RUN_DESCRIPTION,
    _TEST_CASE_DESCRIPTION,
    _TEST_CASE_DESCRIPTIONS,
    _TEST_RUN_DESCRIPTION,
    _TEST_RUN_DESCRIPTIONS,
)

URL = os.environ["WEAVIATE_URL"].rstrip("/")
KEY = os.environ["WEAVIATE_API_KEY"]


def _req(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{URL}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def _apply(cls_name: str, cls_desc: str, prop_desc: dict[str, str]) -> None:
    cls = _req("GET", f"/v1/schema/{cls_name}")
    cls["description"] = cls_desc
    for prop in cls.get("properties", []):
        desc = prop_desc.get(prop["name"])
        if desc:
            prop["description"] = desc
    _req("PUT", f"/v1/schema/{cls_name}", cls)


def main() -> int:
    targets = [
        (TEST_RUN, _TEST_RUN_DESCRIPTION, dict(_TEST_RUN_DESCRIPTIONS)),
        (
            TEST_CASE,
            _TEST_CASE_DESCRIPTION,
            {**_TEST_CASE_DESCRIPTIONS, "belongsToRun": _BELONGS_TO_RUN_DESCRIPTION},
        ),
    ]
    for cls_name, cls_desc, prop_desc in targets:
        _apply(cls_name, cls_desc, prop_desc)
        # verify
        cls = _req("GET", f"/v1/schema/{cls_name}")
        props = cls.get("properties", [])
        with_desc = sum(1 for p in props if p.get("description"))
        print(
            f"{cls_name}: class description {'set' if cls.get('description') else 'MISSING'}; "
            f"properties with description {with_desc}/{len(props)}; "
            f"vectorizer={cls.get('vectorizer')} "
            f"vectorConfig={list((cls.get('vectorConfig') or {}).keys())}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
