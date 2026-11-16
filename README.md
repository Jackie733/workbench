# Workbench — 轻规范与验证驱动的 Agent 需求交付工作台

本地优先、Agent 无关的 **Spec & Verification Workbench**（基于 **Lightweight SDD + VDD**：轻规范锚定与验证驱动开发）。它帮助开发者在同一个工作台内统筹多个需求：由人类用一句话定义目标并在关键节点拍板，由 AI Coding Agent 负责整理规范、撰写方案、拆分执行与运行验证。

仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。本机源码：`/home/jackie/code/workbench`。

---

## 核心特性与设计理念

1. **三层解耦的统一技术栈（TypeScript / Bun）**
   - **Workbench Core (`src/core/`)**：直接运行于本地环境，管理 `.workbench/` 混合存储（人类可读 `spec.md` / `design.md` + 轻量 `state.json`）、Git 变更观察与真实测试执行。
   - **通用工具接口（`src/mcp/` + `src/cli/`）**：暴露 `wb_list`、`wb_get`、`wb_propose`、`wb_update_tasks`、`wb_verify` 五个正交工具，支持 `omp`、Claude Code、Codex CLI、Cursor、OpenCode 等任意 AI Coding Agent。
   - **本地极简 Web UI (`src/server/` + `src/web/`)**：提供响应式全局首页与三页签工作区，原生支持 Markdown 渲染、代码 Diff 审阅、终端日志展开、亮/暗色主题与 WebSocket 实时更新。
2. **双轨自适应工作流（Plan-First vs Fast-Track）**
   - **标准模式（Plan-First）**：`draft` → `designing` → `awaiting_approval`（人审方案）→ `implementing` → `awaiting_acceptance`（人看验证证据与 Diff 验收）→ `done`。
   - **快速通道（Fast-Track）**：针对明确小需求，人可授权直接跳过方案审批进入 `implementing`，但仍必须通过**真实测试证据 + 人工验收**闭环。
3. **验证驱动与人工主权边界**
   - Agent 不能口头宣布任务完成，也不能自行批准方案或验收通过；验证结论必须来自工作台真实运行测试命令的退出码、日志与当前 Git 代码快照指纹绑定。代码一旦在测试后继续改动，旧证据自动标为过期（`stale`）。
4. **`omp` 原位会话桥接 (`omp/index.ts`)**
   - 在 `omp` 终端中直接注册 5 个 `wb_*` 原生工具与 `/wb` 命令：`/wb` 自动启动/复用本地工作台服务并打开 Web UI，同时将用户在工作台点击按钮生成的指令安全投递至当前 `omp` 会话（忙碌或已有草稿时安全拒绝，绝不覆盖输入）。

---

## 快速上手

### 1. 环境准备

```sh
bun install
```

### 2. 启动工作台 Web UI

```sh
# 在当前 Git 项目根目录初始化并启动 Web 服务（也可以在浏览器首页完成初始化）
bun run src/cli/index.ts init --local
bun run src/cli/index.ts serve --port 4318
```

随后在浏览器访问输出的地址（如 `http://127.0.0.1:4318`）。

### 3. 在 `omp` 中使用

本机 `~/.omp/agent/extensions/workbench.ts` 已重导出 [omp/index.ts](omp/index.ts)（或使用 `omp --extension /home/jackie/code/workbench/omp/index.ts` 启动）。进入项目会话后直接输入 `/wb` 即可打开工作台并建立实时会话桥接。

### 4. 在其他 AI Coding Agent 中挂载 MCP Server

任何支持标准 stdio MCP 的 Agent（Claude Code、Cursor、Codex CLI、OpenCode 等）均可添加如下配置：

```json
{
  "mcpServers": {
    "workbench": {
      "command": "bun",
      "args": ["run", "/home/jackie/code/workbench/src/cli/index.ts", "mcp"]
    }
  }
}
```

也可以直接允许 Agent 调用 CLI：`bun run /home/jackie/code/workbench/src/cli/index.ts --json <list|get|create|propose|tasks|verify>`。

### 5. 运行测试与类型检查

```sh
bun test
bun run typecheck
```

---

## 权威文档

| 文档 | 用途 |
| :--- | :--- |
| [设计规范](docs/DESIGN.md) | 产品定位、SDD+VDD 工作流、三层解耦架构、零废话 Web UI 与通用 Agent 工具接口 |
| [领域契约](docs/DOMAIN_CONTRACT.md) | `.workbench/` 混合存储结构、原子持久化与 CAS、双轨规则、验证证据绑定与人工主权不变量 |
| [实施任务](docs/TASKS.md) | `WB-01`–`WB-07` 的依赖、交付物、验收标准与实测执行记录 |
| [历史归档](docs/archive/README.md) | 旧版 Tern-Luau 方案、2026-11-16 归档文档（`AF-01–AF-16`）与早期阶段记录，仅供追溯 |

---

## 运行与安全边界

- **本地数据策略**：新架构需求资料存放在项目 `.workbench/` 下，初始化时可由用户显式选择「仅本机排除（写入 `.git/info/exclude`）」或「随项目 Git 跟踪」；有意不读取或自动迁移旧版 `.omp/workbench/` 数据。
- **单向拍板控制**：MCP Server 与 `wb` CLI 绝不向 Agent 暴露 `approve`（批准方案）或 `accept`（最终验收）接口；零必需验收条件禁止直接验收通过。
- **诚实边界**：工作台门禁是面向交付流程的工程护栏，而非操作系统级沙箱；不擅自修改模型配置，不自动执行 `git commit`、`git push` 或分支合并。
