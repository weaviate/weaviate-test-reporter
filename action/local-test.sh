#!/usr/bin/env bash
# Local developer convenience: run the action against a Weaviate instance
# from this directory. Mirrors what action.yml does in CI so the same code
# path is exercised — useful for debugging an ingestion issue without
# pushing to GitHub.
#
# Prereqs:
#   - Python 3.11 (pyenv-managed is fine).
#   - A reachable Weaviate (default: http://localhost:8080). Anonymous
#     access works (WEAVIATE_API_KEY="").
#   - This repo's venv: `python3.11 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
#
# All env vars below are overridable. The most common knob is JUNIT_PATH,
# which controls WHICH JUnit XML file (or glob) the action parses:
#
#   ./local-test.sh                                          # default fixture
#   JUNIT_PATH="reports/junit.xml" ./local-test.sh           # one file
#   JUNIT_PATH="reports/junit-*.xml" ./local-test.sh         # one-level glob
#   JUNIT_PATH="**/test-results*.xml" ./local-test.sh        # recursive glob
#   JUNIT_PATH="/abs/path/to/report.xml" ./local-test.sh     # absolute path
#
# Common multi-knob examples:
#
#   # Against WCD with a real API key:
#   WEAVIATE_URL="https://my-cluster.weaviate.cloud" \
#   WEAVIATE_API_KEY="$WCD_KEY" \
#   JUNIT_PATH="reports/e2e.xml" \
#   JOB_NAME="e2e-backup" \
#       ./local-test.sh
#
#   # Against weaviate-local-k8s using its bundled model2vec:
#   VECTORIZER="text2vec-model2vec" \
#   MODEL2VEC_INFERENCE_URL="http://model2vec-inference.weaviate.svc.cluster.local.:8080" \
#       ./local-test.sh
#
#   # Fail-safe off so any ingestion error exits non-zero (debugging):
#   FAIL_ON_ERROR="true" VERBOSE="true" ./local-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Action inputs (mirror the keys defined in action.yml) ----------------
export WEAVIATE_URL="${WEAVIATE_URL:-http://localhost:8080}"
export WEAVIATE_API_KEY="${WEAVIATE_API_KEY:-}"
# JUNIT_PATH: file path or glob to the JUnit XML report(s) the action will
# parse. Defaults to the small bundled fixture so the script "just works".
export JUNIT_PATH="${JUNIT_PATH:-tests/unit/fixtures/pytest_simple.xml}"
export JOB_NAME="${JOB_NAME:-local-dev}"
# fail_on_error defaults to true here (the opposite of the action default)
# because for local debugging you usually want to see real errors loudly.
export FAIL_ON_ERROR="${FAIL_ON_ERROR:-true}"
export VECTORIZER="${VECTORIZER:-text2vec-weaviate}"
export MODEL2VEC_INFERENCE_URL="${MODEL2VEC_INFERENCE_URL:-}"
export VERBOSE="${VERBOSE:-false}"

# --- Synthetic GitHub Actions context -------------------------------------
# These mirror what GitHub Actions sets at runtime. The action treats them
# as required, so we synthesize plausible values from the local git state.
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
echo "    VECTORIZER=$VECTORIZER"
echo "    FAIL_ON_ERROR=$FAIL_ON_ERROR"
echo

exec "$PY" -m weaviate_test_reporter
