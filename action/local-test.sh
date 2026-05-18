#!/usr/bin/env bash
# Local developer convenience: run the action against a local Weaviate instance
# from inside this directory. Mirrors what action.yml does in CI so the same
# code path is exercised.
#
# Prereqs:
#   - Python 3.11 (pyenv-managed is fine)
#   - A local Weaviate listening on http://localhost:8080 (e.g., via
#     `docker run -p 8080:8080 -p 50051:50051 cr.weaviate.io/semitechnologies/weaviate:latest`)
#   - This repo's venv set up: `python3.11 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
#
# Usage:
#   ./local-test.sh                                  # uses pytest_simple.xml
#   JUNIT_PATH='reports/*.xml' ./local-test.sh       # custom glob
#   FAIL_ON_ERROR=true ./local-test.sh               # strict mode for debugging

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# User inputs (override via env if you want).
export WEAVIATE_URL="${WEAVIATE_URL:-http://localhost:8080}"
export WEAVIATE_API_KEY="${WEAVIATE_API_KEY:-}"
export JUNIT_PATH="${JUNIT_PATH:-tests/unit/fixtures/pytest_simple.xml}"
export JOB_NAME="${JOB_NAME:-local-dev}"
export FAIL_ON_ERROR="${FAIL_ON_ERROR:-true}"  # strict by default for local debugging

# Synthetic GitHub Actions context.
export GH_REPOSITORY="${GH_REPOSITORY:-local/weaviate-test-reporter}"
export GH_RUN_ID="${GH_RUN_ID:-$(date +%s)}"
export GH_RUN_ATTEMPT="${GH_RUN_ATTEMPT:-1}"
export GH_WORKFLOW="${GH_WORKFLOW:-local-test}"
export GH_REF="${GH_REF:-main}"
export GH_SHA="${GH_SHA:-$(git rev-parse HEAD 2>/dev/null || echo localdev)}"
export GH_EVENT_NAME="${GH_EVENT_NAME:-push}"
export GH_ACTOR="${GH_ACTOR:-$USER}"
export GH_SERVER_URL="${GH_SERVER_URL:-https://github.com}"
export GH_PR_NUMBER="${GH_PR_NUMBER:-}"

# Make src/ importable without an editable install.
export PYTHONPATH="${SCRIPT_DIR}/src"

if [ -x "${SCRIPT_DIR}/.venv/bin/python" ]; then
    PY="${SCRIPT_DIR}/.venv/bin/python"
else
    PY="python3.11"
fi

echo "==> Running with:"
echo "    WEAVIATE_URL=$WEAVIATE_URL"
echo "    JUNIT_PATH=$JUNIT_PATH"
echo "    JOB_NAME=$JOB_NAME"
echo "    FAIL_ON_ERROR=$FAIL_ON_ERROR"
echo

exec "$PY" -m weaviate_test_reporter
