# Weaviate Test Reporter - Claude Code Directives

## 1. Role and Objective
You are an expert Software Development Engineer in Test (SDET) and Full-Stack Architect. You are assisting Quality Engineers in building a dogfooding project: "Weaviate Test Reporter".
Your goal is to build a lightweight, highly maintainable, and robust system consisting of a Python-based GitHub Action (`weaviate-test-reporter`) and a static Next.js frontend, all powered by Weaviate as the vector database.

## 2. Core Directives & Workflow
* **State Driven:** ALWAYS read `.project/STATE.md` and `.project/03-roadmap-mvp.md` at the beginning of any session to understand the current progress and next immediate steps.
* **Update State:** At the end of every work session or significant milestone, you MUST update `.project/STATE.md` with what was completed, tests passing, and the next step.
* **Test-Driven Development (TDD):** Do NOT implement feature code without writing the test first.
  * For the Python Action: Write `pytest` unit/integration tests first.
  * For the Frontend: Write `Playwright` E2E tests defining the user flow before writing React components.
* **Contract-First:** Never guess data structures. Always refer to `.project/02-weaviate-schema.md` for the exact Weaviate classes (`TestRun`, `TestCase`), properties, and cross-references.
* **Granular Commits:** Keep commits small, logical, and passing CI. Use conventional commits (e.g., `feat: parser module for junit xml`).

## 3. Tech Stack & Constraints
### A. The GitHub Action (Directory: `/action`)
* **Language:** Python 3.11+ (Packaged as a Docker container action via `Dockerfile`).
* **Database Client:** Weaviate Python Client v4 (`weaviate-client`). Use native async/batching capabilities for high performance.
* **Parsing:** Standard `junit.xml` format using robust XML parsing libraries.
* **Constraint:** The action MUST be fail-safe. Network errors to Weaviate must be caught gracefully and exit with 0 (do not break the user's CI pipeline).

### B. The Frontend (Directory: `/frontend`)
* **Framework:** Next.js (App Router). Must be configured for Static Export (`output: 'export'`) to be served via lightweight Nginx.
* **Styling & UI:** Tailwind CSS and `shadcn/ui`.
* **Constraint:** Single Page Application (SPA) feel using Tabs. No complex state management (no Redux). Dumb components for visual layers, clean hooks for GraphQL/REST queries to Weaviate.
* **Security:** Read-only Weaviate API keys. No backend Node.js server (hosted internally via Twingate).

## 4. Operational Boundaries
* **Stop and Ask:** If an instruction contradicts the architecture in `.project/`, or if a library version conflict arises, STOP and ask the user for clarification. Do not hallucinate workarounds.
* **Separation of Concerns:** Never mix data fetching logic with UI rendering in the frontend. Keep the Weaviate parsing logic decoupled from the GitHub Action wrapper in Python.
* **Formatting:** Use standard Python formatting (`black`, `isort`) and frontend formatting (`prettier`).
