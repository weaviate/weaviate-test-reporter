# Weaviate Test Reporter

A Python composite GitHub Action that parses JUnit XML reports from CI jobs and ingests them into Weaviate. Enables semantic search over CI/CD test failures plus a static Next.js dashboard for browsing test runs (Phase 2).

This is a dogfooding project: we use Weaviate to make our own QA workflow faster, and the same pattern can be adopted by any team running CI on GitHub Actions.

## Components

| Path | Description | Status |
|---|---|---|
| [`action/`](action/) | Python composite GitHub Action — parses JUnit XML, batches into Weaviate using server-side streaming (`collection.batch.stream`), fail-safe by default. | ✅ MVP complete |
| `frontend/` | Next.js static SPA with three tabs (Test Explorer, Semantic Search, Metrics Dashboard). | 🟡 Phase 2 — deferred |

## Usage

Add this step to any GitHub Actions workflow that produces JUnit XML:

```yaml
- name: Upload test results to Weaviate
  uses: weaviate/weaviate-test-reporter@v0.1.0
  if: always()  # ingest results even when prior steps failed
  with:
    weaviate_url: ${{ secrets.WEAVIATE_URL }}
    weaviate_api_key: ${{ secrets.WEAVIATE_API_KEY }}
    junit_path: "reports/junit-*.xml"
    job_name: "e2e-backup"
```

### Inputs

| Input | Required | Default | Purpose |
|---|---|---|---|
| `weaviate_url` | yes | — | WCD URL or `http://host:port` for self-hosted |
| `weaviate_api_key` | no | `""` | Write-capable key. Leave empty for anonymous local instances |
| `junit_path` | yes | — | Glob for JUnit XML files (e.g. `reports/*.xml`) |
| `job_name` | yes | — | Logical job name stored on the `TestRun` (e.g. `e2e-backup`) |
| `fail_on_error` | no | `"false"` | If `true`, exit non-zero on ingestion failure. Default is fail-safe so the reporter never breaks user CI |

GitHub Actions context (`repository`, `run_id`, `run_attempt`, `workflow`, `ref`, `sha`, `event_name`, `pull_request.number`, `actor`, `server_url`) is auto-populated as `GH_*` env vars by `action.yml`.

### What gets created in Weaviate

Two collections: **`TestRun`** (filterable; no vectorizer) and **`TestCase`** (three named vectors: `name`, `error_message`, `stack_trace`). The `TestCase` collection cross-references `TestRun` via `belongsToRun`. Vectorizer is selectable per ingest via the `vectorizer` action input — `text2vec-weaviate` (default), `text2vec-model2vec`, or `none`. See [`.project/02-weaviate-schema.md`](.project/02-weaviate-schema.md) for the full contract.

> **Note:** the frontend is a JavaScript SPA — it requires JS to render. The static export ships an empty shell for clients without JS; an internal team dashboard behind Twingate is the target deployment, so this is acceptable.

## Supported JUnit dialects

Tested against pytest, gotestsum (Go), jest-junit, and surefire (Maven). The parser uses [`junitparser`](https://pypi.org/project/junitparser/) so most other JUnit-compatible producers work out of the box.

## Local development

```bash
cd action
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

# Unit tests (no Docker required)
pytest tests/unit/

# Integration tests (requires Docker — spins up real Weaviate + model2vec)
pytest tests/integration/

# Run the action against a local Weaviate
./local-test.sh
```

The integration test uses [`text2vec-model2vec`](https://docs.weaviate.io/weaviate/model-providers/model2vec) (Snowflake/potion-retrieval-32M, ~30MB, no GPU needed) so semantic search behavior is exercised end-to-end without any cloud dependencies.

## Project Documentation

- [`.project/01-architecture.md`](.project/01-architecture.md) — System architecture, action interface contract, parsing strategy.
- [`.project/02-weaviate-schema.md`](.project/02-weaviate-schema.md) — `TestRun` and `TestCase` schema (the data contract).
- [`.project/03-roadmap-mvp.md`](.project/03-roadmap-mvp.md) — MVP scope and phased roadmap.
- [`.project/04-backlog.md`](.project/04-backlog.md) — Out-of-scope features (post-MVP).
- [`.project/STATE.md`](.project/STATE.md) — Live session state and next steps.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
