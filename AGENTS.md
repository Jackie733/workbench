# Repository Guidelines

## Project Overview

Workbench coordinates design, implementation, review, and verification across local Git projects and coding-agent CLIs. Humans approve designs and accept results. Keep those decisions out of agent-facing tools; verification evidence must match the current spec and Git snapshot.

## Architecture & Data Flow

- **Project state lives on disk.** Each repo owns its `.workbench/project.json` (including routing) and `.workbench/items/REQ-*/` (spec, design, state, evidence, and runs). `~/.workbench-hub/` holds the cross-project registry and telemetry, not the authoritative requirement state.
- **All transports share the domain engine.** CLI, stdio MCP, and HTTP handlers call `src/core/engine.ts`. Put transition and verification rules there, not in a route or React component. Local Hub requests and requests forwarded to a remote node use the same project API handler.
- **A browser mutation makes a round trip.** The handler calls core; core validates and persists the change under a project lock; the server broadcasts an update. The browser invalidates TanStack Query data and refetches. Live run events update stream state directly; preserve the timestamp guard so an older snapshot cannot overwrite a newer event.

## Key Directories

- `src/core/`: project contracts, storage, Git operations, lifecycle gates, and verification.
- `src/hub/`: project registry, harness routing, subprocess execution, stream adapters, and remote-node bridge.
- `src/cli/`, `src/mcp/`, `src/server/`: command, stdio tool, and HTTP/WebSocket boundaries. MCP is not an HTTP endpoint.
- `src/web/`: React client. `queries.ts` owns server-state synchronization; `stores/` holds Zustand UI, draft, and live-stream state. Do not mirror fetched project records in a second store.

## Development Commands

```sh
bun install
bun run serve --hub --host 127.0.0.1 --port 4318 --root "$PWD"  # foreground Hub
bun run mcp --root "$PWD"                                      # stdio; initialized project
bun run typecheck                                               # strict tsc --noEmit
bun test tests/core/engine.test.ts                              # focused domain tests
bun run test                                                    # isolated full regression
```

There is no standalone build or lint script. The server bundles the browser entry with `Bun.build` and compiles Tailwind at startup. Set `WORKBENCH_DEV_WEB=1` for UI development. Do not start a foreground Hub alongside a managed Hub for the same installation.

## Code Conventions & Common Patterns

- Match the surrounding TypeScript: two-space indentation, double quotes, semicolons, camelCase functions, PascalCase types and React components.
- Use `WorkbenchError` with a stable code and optional structured details. Map codes to HTTP status at the transport boundary; do not branch on human-readable messages. On `revision_conflict`, refresh authoritative state rather than overwriting it.
- Inject services through typed factory parameters: `createProjectApiHandler(deps: ProjectApiDeps)` takes the executor, broadcaster, and watcher hooks. Extend that seam rather than introducing a global or separate local/remote implementations.
- Keep asynchronous agent runs in `HubExecutor`; it owns active jobs, cancellation, logs, and code-root locks. Use core storage helpers for atomic writes and safe paths instead of editing item JSON from an adapter.

## Important Files

- `src/cli/index.ts`: `wb` entry and command dispatch. `src/server/index.ts`: server composition and web bundling. `src/web/app.tsx`: React entry.
- `src/core/types.ts`, `src/core/validate.ts`, `src/core/store.ts`: check these together when changing a persisted shape. For schema v6, use `docs/DOMAIN_CONTRACT.md` rather than older README examples or archived plans.
- `docs/FLOW.md` describes the intended workflow; `docs/TASKS.md` tracks implementation progress. Consult `.workbench/playbook.md` for project-specific decisions and known failed approaches.

## Runtime/Tooling Preferences

Use current stable Bun and Git. `package.json` exposes TypeScript source directly as `wb`; install with Bun using `bun.lock`, not npm. `tsconfig.json` uses strict checking and bundler module resolution. Agent CLIs are integrations, not the host runtime. For service installation use `docs/DEPLOYMENT.md`; deployment is not a build check.

## Testing & QA

Use `bun:test`. During iteration run typecheck and the affected `tests/<area>/*.test.ts` files, including caller tests when shared behavior changes. For storage or Git behavior, follow the temporary-project setup and cleanup in `tests/core/engine.test.ts`.

With no arguments, `scripts/test.ts` runs each file in its own process and temporary Hub directory. Arguments pass through to plain `bun test` without that isolation. Set `WORKBENCH_TEST_FLAKY_RETRIES=0` to diagnose first-attempt failures. Browser suites can skip when Chromium is unavailable: for UI changes, confirm the relevant Puppeteer case ran, not just that the command exited successfully. No numeric coverage threshold is configured.
