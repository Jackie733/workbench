**English** | [简体中文](README.zh-CN.md)

# Workbench — Resident Multi-Project Hub & Multi-Model Routing Workbench (v5.0)

A local-first, always-on, agent-agnostic **Spec & Verification Workbench Hub** built on **Lightweight SDD + VDD**. It lets you coordinate **multiple local Git projects** and **multiple AI subscription quotas (ChatGPT Plus / Google AI Pro / QoderCN / OpenCode Go / omp)** inside one resident three-column web command center — humans keep the two decisive checkpoints (design approval and real-evidence acceptance), while the hub routes each stage to the most suitable model for execution, discussion, and cross-review.

`omp` is only one optional integration adapter, not a host and not a required dependency: any installed coding agent CLI (`codex` / `qodercn` / `opencode` / `agy` / `omp`) can be dispatched.

Repository: [Jackie733/workbench](https://github.com/Jackie733/workbench).

---

## Core Features (v5.0 Hub)

1. **Resident multi-project control center (`wb start` / `wb open`)**
   - The global `wb` CLI installs onto `$PATH` via `bun link`; a user-level service is the recommended way to host the hub (default port `4318`, data in `~/.workbench-hub/`).
   - The three-column web command center gives you **live project switching**, a **local directory browser with guided initialization**, pending-approval counters, and agent-run breathing indicators in the left rail.
2. **Multi-harness auto-discovery and stage-based routing**
   - Automatically discovers local `codex`, `qodercn`, `opencode`, `agy` (Antigravity / Gemini CLI), and `omp` installations plus their model catalogs, and lets you append paid models such as OpenCode Go.
   - Ships with `balanced` (recommended default), `sota_first`, and `quota_saver` presets: scarce SOTA quota goes to the low-token, high-leverage `design` and `review` stages, while high-frequency `implement` / `fix` work routes to high-throughput or free models.
   - **Stage actions with a live terminal**: select a model in the action banner, start the agent through an explicit stage action such as generating a design or starting implementation, stream child-process logs into the console, terminate runs at any time, or retry on a fallback model after a rate limit or failure.
3. **Two-tier cross-harness handoff and PR-style co-design**
   - **Two-tier handoff**: same-harness continuation reuses each CLI's native session mechanism; after a harness switch or an abnormal interruption, the hub synthesizes a bounded `handoff.md` (contract facts, agent notes and dead ends, the `git diff` scene, and the tail of the failing log).
   - **Non-linear co-design**: hover any section of `spec.md`, `design.md`, or an acceptance criterion to add an inline **`[💬 annotate / ask]`** note; the discussion rail separates **Ask** (read-only) from **Refine** (which re-proposes the design and opens a `vN-1 → vN` diff). Humans can also edit `design.md` directly.
4. **Verification-driven with human sovereignty**
   - No agent (CLI, MCP, or hub child process) can forge a `passed` status or replace a human clicking `approve`, `fast_track`, or `accept`. Cross-model review verdicts (`pass / concern / block`) and verification evidence are bound to the current `specHash` and workspace Git snapshot fingerprint, and are marked `stale` as soon as code changes.
5. **LAN access and remote nodes**
   - The hub listens on `127.0.0.1` only by default; LAN access requires an explicit `wb service install --host 0.0.0.0`, and every non-loopback client must authenticate with the access password (browser login or `Authorization: Bearer <password>`).
   - `wb service password` generates or resets that LAN password, which is also the `wb node install --token` secret. WSL2 and similar environments can install the lightweight bridge with the `wb node` commands to attach their files and commands to the primary hub.
6. **Self-evolution, GitHub integration, and output language**
   - **Playbook**: acceptance notes, rejections, and human annotations settle into a project-level `.workbench/playbook.md` and are injected into later handoffs so agents stop repeating known dead ends.
   - **Pain-point inbox**: `wb issue "<description>"` records defects in Workbench itself into `~/.workbench-hub/evolution/inbox.jsonl` (fingerprint-deduplicated) for human triage, then evolves it in an isolated Git worktree sandbox.
   - **GitHub integration**: `wb github status | import <issueRef> | link-issue <REQ-ID> [issueRef]` reuses your local authenticated `gh` session to import or link issues; `wb config --github-repo <owner/repo>` pins the project repository, and standard PR delivery is available after human acceptance.
   - **Output language**: `wb init --lang zh-CN|en|auto` and `wb config --output-language ...` control the language of specs, designs, review reports, and handoff packs (project-level overrides the global default).

---

## Quick Start

### 1. User-level service deployment (recommended)

Install Git, a current stable Bun, and keep the source at a fixed location. Then run from the source root:

```sh
bun run deploy --port 4318
wb service status
# Initialize new projects as needed; existing projects need no rebuild
wb --root /absolute/path/to/project init
bun run deploy:check --url http://127.0.0.1:4318 --root /absolute/path/to/project
wb open
```

macOS uses a LaunchAgent; Linux/WSL2 uses a systemd user service, and WSL2 requires systemd plus a working user session. By default the service listens on loopback only and reuses the current user's agent CLIs and credentials without modifying any login state.

To reach the hub from other devices on the LAN, reinstall with an explicit `0.0.0.0` bind and generate an access password:

```sh
wb service install --port 4318 --host 0.0.0.0
wb service password
```

Non-loopback clients must log in with that password. Only a scrypt hash is stored in `<hubDir>/auth.json` (mode `0600`, directory `0700`); the plaintext never enters service definitions or logs. **Do not** bind `0.0.0.0` as a fallback for local access problems.

To attach WSL2 (or similar) files and commands to a primary hub, install the remote node service with the same access password:

```sh
wb node install --hub http://192.168.1.10:4318 --token <access-password>
wb node status
```

The remote node service is independent of the primary hub service: `wb service stop/uninstall` neither stops nor uninstalls the node, and vice versa.

Full installation, start/stop, update, log, backup, uninstall, and Windows MCP configuration details live in the [deployment guide](docs/DEPLOYMENT.md). Once installed, `wb start/open/stop/restart` are executed by the service manager, and `wb status` reports both manager and hub health.

Without the service installed you can still start the original unmanaged background hub via `wb start` / `wb open`, or choose foreground serving explicitly (never alongside a managed hub for the same installation):

```sh
bun run src/cli/index.ts serve --hub --host 127.0.0.1 --port 4318 --root "$HOME"
```

Inside the web workbench, use **`+ Add`** in the left rail to browse and register local Git repositories, or **`⚙ Routing`** to tune per-subscription model allocation.

### 2. Optional integration: omp bridging or any MCP client

- **omp session bridge (optional)**: register [omp/index.ts](omp/index.ts) as an omp extension, then type `/wb` to open the workbench and establish a live command bridge; the project-level server lifecycle is independent of the global hub service. Workbench runs fine without `omp`.
- **Other MCP clients (Claude Code / Codex / Cursor / OpenCode, etc.)**: MCP is a stdio child process started by the client — there is no `/mcp` network endpoint. Use real absolute paths and an initialized project:

```json
{
  "mcpServers": {
    "workbench": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/workbench/src/cli/index.ts", "mcp", "--root", "/absolute/path/to/project"]
    }
  }
}
```

### 3. Local development, tests, and type checking

```sh
bun install
bun test
bun run typecheck
```

---

## Documentation

| Document | Purpose |
| :--- | :--- |
| [Chinese README](README.zh-CN.md) | Fully equivalent Chinese version of this document |
| [Design specification](docs/DESIGN.md) | v5.0 hub positioning, multi-harness routing matrix, two-tier handoff, co-design loop, and command-center UI |
| [Deployment guide](docs/DEPLOYMENT.md) | macOS/Linux/WSL2 user services, LAN access and remote nodes, real HTTP/WS/MCP checks, Windows clients, and recovery boundaries |
| [Domain contract](docs/DOMAIN_CONTRACT.md) | `.workbench/` and `~/.workbench-hub/` storage layers, invariants, and verification/sovereignty gates |
| [Implementation tasks](docs/TASKS.md) | Phase 1 (`WB-01`–`WB-07`) and Phase 2 (`WB-08`–`WB-12`) progress and measured evidence |
| [Historical archive](docs/archive/README.md) | Legacy Tern-Luau design (archived 2026-11-16) kept for reference only |

---

## Runtime & Security Boundaries

- **Local data policy**: business data lives per project under each repository's `.workbench/` (excluded through `.git/info/exclude` by default); the global project list and routing policy live in `~/.workbench-hub/`.
- **Access boundary**: loopback only by default; explicit LAN access is password-protected (scrypt hash on disk, mode `0600`), and credentials never enter service definitions or logs.
- **One-way approvals**: the MCP server and `wb` CLI expose no `approve`, `fast_track`, `accept`, or PR-push interface to agents, and zero required criteria can never pass acceptance.
- **Controllable subprocesses and honest limits**: the hub binds every external CLI child process to its own process group (one-click kill without orphans), never modifies external CLI global authentication, and only performs controlled `git commit`, `git push`, and `gh` issue/PR sync after human acceptance and explicit confirmation.
