# Weaviate Test Reporter

A Python composite GitHub Action that parses JUnit XML reports from CI jobs and ingests them into Weaviate — plus a static Next.js dashboard for browsing the results with semantic search and metrics.

Dogfooding project: we use Weaviate to make our own QA workflow faster, and the same pattern is portable to any team running CI on GitHub Actions.

## Components

| Path | Description |
|---|---|
| [`action/`](action/) | Python composite GitHub Action. Parses JUnit XML, batches into Weaviate using server-side streaming (`collection.batch.stream`), fail-safe by default. |
| [`frontend/`](frontend/) | Next.js 16 static SPA with five tabs: Test Explorer, Versions, Semantic Search, Metrics Dashboard, and "Ask your tests" (Query Agent chatbot — WCD-only; hidden on local clusters). |

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
| `version_under_test` | no | `""` | SemVer 2.0 string identifying the artifact under test (e.g. `1.38.1-rfea1de`, `1.36.14-3b58915`, `1.38.0-dev-9479337`, plain `1.37.5`). Accepts an optional `v`/`V` prefix. Populates THREE derived properties on `TestRun`: `version_full` (verbatim build-unique identifier for dedup), `version_patch` (canonical `MAJOR.MINOR.PATCH`, pre-release dropped), `version_minor` (`MAJOR.MINOR`). **A non-empty value MUST be valid SemVer 2.0** — anything else (branch name, `latest_release` placeholder) causes the action to exit non-zero at startup |

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

# Production build (output: "standalone") — a Node server, not a static export.
npm run build                     # emits .next/standalone (run: node .next/standalone/server.js)

# E2E tests against the dev server + a seeded Weaviate.
npm run test:e2e
```

### Environment variables (frontend)

The dashboard is a Next.js **server** (not a static export). It reads two **server-only** env vars at **runtime** — they are never shipped to the browser. The browser talks only to same-origin `/api/*` routes, which query Weaviate server-side via the TypeScript client.

| Variable | Required | Purpose |
|---|---|---|
| `WEAVIATE_URL` | yes | Cluster URL the **server** uses to reach Weaviate (e.g., `http://localhost:8080` or your WCD cluster URL). |
| `WEAVIATE_API_KEY` | no | Read-only API key. Server-side only. Leave empty for anonymous Weaviate (local dev). |

For local dev, put them in `frontend/.env.local` (gitignored):

```bash
# frontend/.env.local  (gitignored)
WEAVIATE_URL=http://localhost:8080
WEAVIATE_API_KEY=
```

**Production.** CI publishes the container image to GHCR (`.github/workflows/frontend-image.yml`). The deployment environment (managed separately, outside this repo) supplies `WEAVIATE_URL` and `WEAVIATE_API_KEY` to the container as **runtime env vars** — the key is never baked into the image, the repo, or CI.

### Run the production container locally

To exercise the exact image that gets deployed (the standalone Node server, not the dev
server), build the container and run it with the server-side creds from
`frontend/.env.local`. **Run these from the repository root** (the paths reference
`frontend/...`):

```bash
# Build the standalone image (the same one CI publishes to GHCR).
docker build -t weaviate-test-reporter-frontend frontend

# Run it, injecting WEAVIATE_URL + WEAVIATE_API_KEY at runtime from .env.local.
docker run -d --name reporter-ui \
  --env-file frontend/.env.local \
  -p 3030:8080 \
  weaviate-test-reporter-frontend

# → open http://localhost:3030
docker logs -f reporter-ui     # follow logs
docker stop reporter-ui        # stop  (docker start reporter-ui to resume)
docker rm -f reporter-ui       # remove when done
```

The key is injected at **runtime** (never baked into the image) — in production the
deployment environment supplies it the same way (from its own secret store instead of
`--env-file`), which the app can't tell apart.

### Dashboard architecture notes

- The browser never talks to Weaviate. It calls same-origin `/api/*` route handlers that run the official `weaviate-client` v3 (REST/gRPC) server-side — so the cluster URL and key stay on the server. (This replaced the earlier browser-side GraphQL approach, which is being deprecated.)
- The app requires JS (like any SPA). Acceptable for an internal tool.

## CI

| Workflow | What it does |
|---|---|
| `lint` | ruff + black on `action/` |
| `unit (3.11 / 3.12)` | `pytest tests/unit/` matrix |
| `integration` | testcontainers-backed end-to-end against Weaviate + model2vec |
| `action-smoke` | invokes `uses: ./action` end-to-end against service-container Weaviate + model2vec; catches issues that unit / integration tests can't (action.yml contract, GH context wiring) |
| `frontend.build` | lint + production build (compile check) |
| `frontend.unit` | Vitest unit tests (server query logic, route mapping) |
| `frontend.e2e` | runs Playwright against ephemeral Weaviate + model2vec services |
| `frontend-image` | builds the frontend container and publishes it to GHCR (the deploy image) |

## License

BSD-3-Clause — see [`LICENSE`](LICENSE).
