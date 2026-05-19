# Weaviate Test Reporter

A Python composite GitHub Action that parses JUnit XML reports from CI jobs and ingests them into Weaviate — plus a static Next.js dashboard for browsing the results with semantic search and metrics.

Dogfooding project: we use Weaviate to make our own QA workflow faster, and the same pattern is portable to any team running CI on GitHub Actions.

## Components

| Path | Description |
|---|---|
| [`action/`](action/) | Python composite GitHub Action. Parses JUnit XML, batches into Weaviate using server-side streaming (`collection.batch.stream`), fail-safe by default. |
| [`frontend/`](frontend/) | Next.js 16 static SPA with three tabs (Test Explorer, Semantic Search, Metrics Dashboard). |

## Usage — the action

Add this step to any GitHub Actions workflow that produces JUnit XML:

```yaml
- name: Upload test results to Weaviate
  uses: weaviate/weaviate-test-reporter/action@v1
  if: always()  # ingest results even when prior steps failed
  with:
    weaviate_url: ${{ secrets.WEAVIATE_URL }}
    weaviate_api_key: ${{ secrets.WEAVIATE_API_KEY }}
    junit_path: "reports/junit-*.xml"
    job_name: "e2e-backup"
```

> The `/action` segment in the `uses:` line points GitHub at the `action/` subdirectory where `action.yml` lives — `weaviate/weaviate-test-reporter@v1` would 404 because there is no root-level `action.yml` in this repo.

### Inputs

| Input | Required | Default | Purpose |
|---|---|---|---|
| `weaviate_url` | yes | — | WCD URL or `http://host:port` for self-hosted |
| `weaviate_api_key` | no | `""` | Write-capable key. Leave empty for anonymous local instances |
| `junit_path` | yes | — | Glob for JUnit XML files (e.g. `reports/*.xml`) |
| `job_name` | yes | — | Logical job name stored on the `TestRun` (e.g. `e2e-backup`) |
| `fail_on_error` | no | `"false"` | If `true`, exit non-zero on ingestion failure. Default is fail-safe so the reporter never breaks user CI |
| `vectorizer` | no | `"text2vec-weaviate"` | One of `text2vec-weaviate`, `text2vec-model2vec`, `none`. Only applied on first-time collection creation |
| `model2vec_inference_url` | no | `""` | Required when `vectorizer = text2vec-model2vec`. URL from Weaviate's perspective (e.g., `http://model2vec:8080` in-cluster) |
| `verbose` | no | `"false"` | If `true`, emit verbose pip + structlog DEBUG output |
| `version_under_test` | no | `""` | Semver of the artifact under test (e.g. `1.37.5`, `v1.37.5`, `1.37.5-rc1`). When set, populates `version_full` and `version_minor` on the `TestRun` so the dashboard can aggregate per Weaviate version. Empty or non-semver values are warned-and-skipped — the action never fails on this input alone |

GitHub Actions context (`repository`, `run_id`, `run_attempt`, `workflow`, `ref`, `sha`, `event_name`, `pull_request.number`, `actor`, `server_url`) is auto-populated as `GH_*` env vars by `action.yml`.

### What lands in Weaviate

Two collections:

- **`TestRun`** (no vectorizer) — filterable / aggregatable.
- **`TestCase`** — three named vectors (`name`, `error_message`, `stack_trace`) so dashboard queries can target the semantic dimension that best matches the query shape. Default target for triage is `stack_trace`.

`TestCase` references `TestRun` via `belongsToRun`. Full contract: [`.project/02-weaviate-schema.md`](.project/02-weaviate-schema.md).

Idempotent UUID5 strategy means re-running a workflow attempt **upserts** existing rows rather than duplicating. `job_name` is part of the UUID derivation, so matrix builds (e.g., one CI run that fans out over `replicas` ∈ {1, 3, 7}) produce a separate `TestRun` per cell as long as each cell passes its own distinct `job_name` — re-runs of that same `job_name` still upsert.

## Supported JUnit dialects

pytest, gotestsum (Go), jest-junit, and surefire (Maven). The parser uses [`junitparser`](https://pypi.org/project/junitparser/) so most other JUnit-compatible producers work out of the box.

## Local development — the action

```bash
cd action
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

# Unit tests (no Docker required).
pytest tests/unit/

# Integration tests (requires Docker — spins up Weaviate + model2vec via testcontainers).
pytest tests/integration/
```

### Run the action against a local Weaviate

`action/local-test.sh` invokes the action against a Weaviate at `http://localhost:8080` with synthetic GitHub metadata.

```bash
# Defaults: ingests action/tests/unit/fixtures/pytest_simple.xml.
./local-test.sh

# Point at your own JUnit XML:
JUNIT_PATH="reports/junit.xml" ./local-test.sh
JUNIT_PATH="**/test-results*.xml" ./local-test.sh   # globs work too

# Other overrides (any subset):
WEAVIATE_URL="https://my-cluster.weaviate.cloud" \
WEAVIATE_API_KEY="$WCD_KEY" \
JOB_NAME="e2e-backup" \
VECTORIZER="text2vec-model2vec" \
MODEL2VEC_INFERENCE_URL="http://model2vec:8080" \
FAIL_ON_ERROR="true" \
  ./local-test.sh
```

### One-off ingest of a real JUnit file

`action/scripts/ingest_local.py` is the developer-friendly CLI for ingesting arbitrary files into a local Weaviate. Unlike `local-test.sh`, it has named flags and falls back to git-derived metadata.

```bash
.venv/bin/python scripts/ingest_local.py path/to/junit.xml
.venv/bin/python scripts/ingest_local.py reports/e2e.xml \
    --job-name e2e-rbac --branch feature/rbac --actor jose
```

### Seed a local Weaviate with synthetic CI history

For demoing the dashboard without a real CI run:

```bash
.venv/bin/python scripts/seed_local.py
```

Generates 10 TestRuns over the last 10 days with a rising failure curve and ~190 TestCases. Vectorizes via `text2vec-model2vec` against the in-cluster `model2vec-inference` service that [`weaviate-local-k8s`](https://github.com/weaviate/weaviate-local-k8s) ships by default.

## Local development — the dashboard

```bash
cd frontend
npm install

# Dev server with hot reload.
npm run dev                       # default port 3000
npm run dev -- --port 3030        # different port (e.g., when local-k8s reserves 3000 for Grafana)

# Production-shape static export (output: "export").
npm run build                     # outputs to ./out

# E2E tests against the dev server + a seeded Weaviate.
npm run test:e2e
```

### Environment variables (frontend)

The dashboard reads two `NEXT_PUBLIC_*` env vars at build time. They are baked into the static bundle, so a different Weaviate target means a rebuild.

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_WEAVIATE_URL` | yes | URL the browser uses to reach Weaviate (e.g., `http://localhost:8080` or your WCD cluster URL). Must serve `Access-Control-Allow-Origin: *` or equivalent for the dashboard's origin. |
| `NEXT_PUBLIC_WEAVIATE_API_KEY` | no | Read-only API key. Leave empty for anonymous Weaviate instances (local dev). |

Put them in `frontend/.env.local` for local dev:

```bash
# frontend/.env.local  (gitignored)
NEXT_PUBLIC_WEAVIATE_URL=http://localhost:8080
NEXT_PUBLIC_WEAVIATE_API_KEY=
```

For production deployment behind Nginx/Twingate, set the env vars at **build time** (in CI) before `npm run build`. The resulting `frontend/out/` directory is a fully static site.

> The browser-exposed API key is documented in [`frontend/lib/env.ts`](frontend/lib/env.ts) — acceptable given the Twingate-gated deployment target. For public deployments, replace with a Cloudflare Worker / edge proxy.

### Dashboard architecture notes

- The browser uses Weaviate's GraphQL endpoint (`/v1/graphql`) because the official `weaviate-client` TS package depends on `@grpc/grpc-js` and can't bundle for a browser-only static SPA. Queries are parameterized via GraphQL variables (no string concatenation of user input).
- The dashboard has a JS-dependency requirement (static export ships an empty shell to no-JS clients). Acceptable for an internal Twingate-gated deployment.

## CI

| Workflow | What it does |
|---|---|
| `lint` | ruff + black on `action/` |
| `unit (3.11 / 3.12)` | `pytest tests/unit/` matrix |
| `integration` | testcontainers-backed end-to-end against Weaviate + model2vec |
| `action-smoke` | invokes `uses: ./action` end-to-end against service-container Weaviate + model2vec; catches issues that unit / integration tests can't (action.yml contract, GH context wiring) |
| `frontend.build` | lint + static export, uploads `out/` artifact |
| `frontend.e2e` | builds + runs Playwright against ephemeral Weaviate + model2vec services |

## License

BSD-3-Clause — see [`LICENSE`](LICENSE).
