# Maintainers guide

This repo ships two artifacts with **separate tag namespaces**:

| Artifact | Lives in | Tags | Consumed by |
|---|---|---|---|
| GitHub action (test reporter) | `action/` | `v1` (moving) + `v1.0.X` (immutable) | CI workflows via `weaviate/weaviate-test-reporter/action@v1` |
| Dashboard image | `frontend/` | `frontend-vX.Y.Z` | Production deployment (auto, on tag push) |

The namespaces must never mix: `frontend-deploy.yml` triggers on `frontend-v*`, so
re-tagging the action's `v1` never deploys the dashboard, and a dashboard release
never changes what action consumers run.

A repo ruleset restricts tag creation, update, and deletion to the Maintain and
Admin roles — pushing a tag is the release/deploy permission.

## Releasing the action

1. Merge the change to `main` (PR + green CI, including the `Action smoke` workflow —
   it is the only check that loads `action/action.yml` for real).
2. Create the immutable release tag:
   ```bash
   git tag v1.0.X <sha> && git push origin v1.0.X
   ```
3. Move the major tag that consumers pin:
   ```bash
   git tag -f v1 <sha> && git push --force origin v1
   ```
   (The tag ruleset allows this for maintainers only.)
4. Nothing to redeploy — consumers (e.g. the weaviate-e2e-tests workflows) pick up
   the new `v1` on their next run.

## Releasing the dashboard (production deploy)

Merging to `main` publishes a GHCR image (`frontend-image.yml`) but deploys nothing.
Deploys are a deliberate, separate step:

1. Pick the commit on `main` you want to ship.
2. Tag and push:
   ```bash
   git tag frontend-vX.Y.Z <sha> && git push origin frontend-vX.Y.Z
   ```
3. `frontend-deploy.yml` builds `frontend/`, pushes the image to Artifact Registry
   (`weaviate-test-reporter/frontend`, europe-west1, auth via Workload Identity
   Federation — no stored credential), and rolls the production service to that
   exact image digest. The job blocks until the new revision is Ready and fails
   otherwise; the run's summary shows the tag, digest, revision, and URL.
4. Watch it: `gh run watch $(gh run list --workflow frontend-deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')`

**Rollback:** tag the last good commit as a new patch release (e.g.
`frontend-vX.Y.Z+1` on the previous sha) and push it — the same pipeline rolls the
service back. Deploys are by digest, so a moving registry tag can never change
what is running.
