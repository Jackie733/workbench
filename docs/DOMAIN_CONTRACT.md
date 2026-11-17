# 领域模型与存储契约规范（v4/v5 混合存储与 Hub 路由基线）

> 本文定义解耦工作台（`Workbench Core` + `Workbench Hub`）的数据存储格式、状态流转规则、模型路由/调度记录结构与不可削弱的工程不变量。产品与架构设计见 [DESIGN.md](DESIGN.md)，实施任务见 [TASKS.md](TASKS.md)。

---

## 1. 存储分层结构

工作台严格隔离**“按 Git 项目归属的业务真相（`.workbench/`）”**与**“全局 Hub 注册与算力路由偏好（`~/.workbench-hub/`）”**：

### 1.1 仓库内项目业务存储（`<projectRoot>/.workbench/`）

项目业务数据统一存储在各自仓库根目录的 `.workbench/` 下，采用 **“可读 Markdown 正文 + 轻量结构化 JSON”** 的混合结构：

```text
.workbench/
├── project.json                  # 项目级元数据 (schemaVersion, projectId, name, nextNumber, privacyMode, createdAt)
├── playbook.md                   # （v5.1 自进化新增）项目持久避坑与偏好法则（最大 16KB），由验收/打回/批注自动沉淀并在交接时注入
└── items/
    └── REQ-001/
        ├── spec.md               # 需求目标 (Goal) 与范围 (Scope) 的 Markdown 正文
        ├── design.md             # 当前技术方案 (Design) 的 Markdown 正文
        ├── handoff.md            # （v5 新增）高信噪比跨 Harness 上下文交接简报（自动合成 + 人类可预览/补充）
        ├── state.json            # 结构化状态、验收标准、批准记录、任务清单、研讨/批注记录、运行摘要与审查结论、时间线
        ├── history/              # 历史批准过的 spec/design 快照 (如 design.v1.md)，用于版本对比
        ├── evidence/             # 真实运行的验证输出日志与元数据 (如 verify-<id>.json / .log)
        └── runs/                 # （v5 新增）主动调度的 Harness 执行日志与完整审查文本 (run-<id>.json / .log)
```

- **隐私与 Git 策略**：首次在项目初始化 `.workbench/` 时，由用户选择：
  - **仅本机跟踪（默认推荐）**：自动将 `/.workbench/` 写入本地 `.git/info/exclude`（不修改团队 `.gitignore`）。
  - **随仓库提交**：不修改排除规则，允许将 `.workbench/` 纳入 Git 版本控制与团队审查。
- **不兼容旧版数据**：旧版 Tern-Luau 架构存储在 `.omp/workbench/` 中的 v1/v2/v3 数据**不再读取、不再兼容、不再自动迁移**。

### 1.2 全局 Hub 存储（`~/.workbench-hub/`，v5 新增）

多项目统筹、守护进程状态与多订阅模型路由策略存放在用户主目录 `~/.workbench-hub/` 下，绝不污染具体业务仓库的 Git 工作区：

```text
~/.workbench-hub/
├── daemon.json                   # 守护进程元数据 (pid, port, url, startedAt, version)
├── service.json                  # 用户级原生服务安装记录 (LaunchAgent / systemd --user，权限 0600)
├── hub.log                       # 守护进程运行日志（按大小自动轮转截断）
├── hub.json                      # 多项目注册表 + 分阶段模型路由配置 + 自定义模型目录
└── evolution/                    # 自进化与 RSI 隔离存储
    ├── inbox.jsonl               # SHA-256 指纹去重的痛点与缺陷收集箱（上限 300 条）
    ├── model-stats.json          # 各 Harness/Model 分阶段胜率、耗时与限流冷却账本
    ├── sandboxes.json            # 活跃 RSI Git Worktree 沙箱登记表（记录分支与分叉基准 HEAD）
    └── worktrees/<REQ-ID>/       # 针对 workbench 自身演进需求的隔离 Git Worktree 沙箱目录
```

`hub.json` 核心字段约束：
- `schemaVersion`: 整数（当前 `1`）。
- `activeProjectId`: 当前选中的默认项目 ID（可为 `null`）。
- `projects[]`: 已纳管项目条目 `{ id, name, root, addedAt, lastOpenedAt }`（`root` 必须为经过 `canonicalRoot` 校验的真实目录）。
- `routing`: `{ activePreset: "balanced" | "sota_first" | "quota_saver", stages: Record<"design" | "implement" | "fix" | "review", StageRouteRule> }`，其中每条 `StageRouteRule` 包含 `{ primary: ModelTarget, fallbacks: ModelTarget[] }`，且 `ModelTarget` 为 `{ harness: HarnessId, model: string, reasoningEffort?: string }`。
- `customModels`: 用户针对任意 Harness 手动追加的模型标识列表（例如付费 Go/API 模型）。

---

## 2. 核心实体与最小数据结构

所有项目 `.workbench/` JSON 文件均包含 `schemaVersion: 4` 与严格的字段校验，未知格式或损坏文件应拒绝覆写并保留原文件供排障。

| 文件 | 核心字段与职责 |
| :--- | :--- |
| `project.json` | `schemaVersion`, `projectId`, `name`, `nextNumber`（单调递增需求编号计数器）, `privacyMode`, `createdAt`, `updatedAt`。 |
| `items/REQ-xxx/spec.md` | 需求目标、背景与范围的纯 Markdown 文本；可供人类在任何编辑器直接阅读或提交 Git 审查。 |
| `items/REQ-xxx/design.md` | 当前技术方案 Markdown 文本（`fast_track` 模式下允许为空）。 |
| `items/REQ-xxx/handoff.md`（v5） | 跨模型交接简报（控制在 1.5k–3k Tokens 预算内），整合契约摘要、关键结论/死胡同、客观 Git 改动、失败证据末尾及未解决讨论。 |
| `items/REQ-xxx/state.json` | `schemaVersion`, `id` (`REQ-001`), `title`, `stage`, `track`, `revision` (CAS 整数), `specHash`, `designVersion`, `designHash`, `criteria`, `approval`, `acceptance`, `tasks`, `baseline`, `verifications`, `timeline`, `lastFeedback`, `blockedFrom`, `blockedReason`, **`handoffNote`**（v5）, **`discussions`**（v5）, **`agentRuns`**（v5）, **`reviewReport`**（v5）, `createdAt`, `updatedAt`。 |
| `items/REQ-xxx/evidence/verify-<id>.json` & `.log` | 不可变验证证据：包含 `id`, `command`, `cwd`, `criterionIds`, `specHash`, `codeSnapshotHash`, `exitCode`, `timedOut`, `durationMs`, `startedAt`, `endedAt`, `passed`, `outputPath`, `outputPreview`, `truncated`。 |
| `items/REQ-xxx/runs/run-<id>.json` & `.log`（v5） | 主动调度运行记录：`id`, `action` (`ask` \| `design` \| `implement` \| `fix` \| `review`), `harness`, `model`, `reasoningEffort?`, `nativeSessionId?`, `status` (`running` \| `succeeded` \| `failed` \| `cancelled`), `startedAt`, `endedAt`, `exitCode`, `durationMs`, `rateLimited?`, `errorSummary?`, `logPath`。 |

v5 新增在 `state.json` 上的结构（向后兼容旧记录，缺失时默认 `[]` / `null`）：
- `handoffNote`（或 `null`）：结构化交接备忘 `{ updatedAt, keyDecisions: string[], deadEnds: string[], nextSteps: string[] }`，允许 Agent 在 `wb_propose` / `wb_update_tasks` 时沉淀高价值定位与踩坑警示。
- `discussions[]`：需求内段落批注与问答讨论流 `{ id, at, actor: "human" | "agent", mode: "ask" | "refine", anchor?: string, harness?: string, model?: string, message: string, resolved?: boolean }`。
- `agentRuns[]`：记录最近运行摘要 `{ id, action, harness, model, nativeSessionId?, status, startedAt, endedAt, exitCode, durationMs, errorSummary? }`，便于前端重连与同构续接。
- `reviewReport`（或 `null`）：最新一次跨模型审查结果 `{ id, reviewerHarness, reviewerModel, verdict: "pass" | "concern" | "block", summary, markdown, reviewedSpecHash, reviewedCodeSnapshotHash, reviewedAt }`；当 `specHash` 或当前代码快照发生变化时，展示层标记该审查报告已过期（`stale`）提示按需复审。

---

## 3. 核心领域不变量（Core Invariants）

以下不变量由 `Workbench Core`（TypeScript/Bun）在领域层强制执行，UI、CLI、MCP Server 与 Hub 调度器共享同一套校验与计算逻辑，不允许任何旁路绕过。

### 3.1 单写者与原子文件更新（Atomic Persistence）
- **统一写入入口**：所有对 `.workbench/` 与 `~/.workbench-hub/` 的状态持久化均通过原子写入流程（同目录临时文件 `.tmp-<uuid>` → `fsync` → `rename`）；`.workbench/` 写入串行化使用进程内队列 + 项目级 `.lock` 文件锁。
- **乐观锁防覆盖（CAS）**：修改 `state.json` 必须校验并递增单调 `revision`。当预期 `revision` 与磁盘当前值不符时拒绝写入并返回冲突详情。
- **路径安全**：所有项目内部文件与 Hub 目录浏览均限制在合法规范目录之内，严禁 `..` 路径穿越或追踪越界符号链接（symlink）。

### 3.2 生命周期枚举与双轨规则
- **持久阶段枚举（8 个清晰状态）**：`draft`、`designing`、`awaiting_approval`、`implementing`、`awaiting_acceptance`、`done`、`blocked`、`cancelled`。
- **双轨模式（`track: "plan_first" | "fast_track"`）**：
  - **`plan_first`（标准模式）**：必须存在对应当前 `specHash` 与当前 `design.md` 摘要的人工批准记录（`approval`），方可进入 `implementing`。当 `spec.md`、`criteria` 或 `design.md` 发生实质修改时，旧批准自动失效并回退至 `awaiting_approval`。
  - **`fast_track`（快速通道）**：必须由人类在 UI 显式点击授权后方可从 `draft` 直接进入 `implementing`，允许无 `design.md`，但仍须绑定需求目标与必需验收条件。
- **终态与阻塞保护**：进入 `blocked` 必须记录非空原因并保存 `blockedFrom`；`done` 与 `cancelled` 允许人工显式 `reopen`，历史批准与验收记录不自动复活。

### 3.3 验证驱动与证据真实性（Verification Truthfulness）
- **禁止口头声明完成**：任何 Agent（无论是通过 MCP、`wb` CLI 还是 `codex`/`qodercn`/`opencode` 子进程）均不得直接将验收条件标为 `passed`。
- **证据三重绑定**：每条 `VerificationRecord` 只能由工作台内置命令执行器真实运行后生成，强制绑定 `specHash`、当前工作区 Git 快照 `codeSnapshotHash` 及真实退出码/日志路径。
- **自动过期检测（Stale Detection）**：代码快照或 `specHash` 一旦变更，旧通过记录实时派生为 `stale`，绝不伪绿。

### 3.4 人工主权边界（Human Sovereignty）
- **不可委托的人类决策**：`approve`（批准方案）、`fast_track`（授权快速通道）与 `accept`（最终验收通过）只能由人类在 Web UI 触发；MCP Server 与 `wb` CLI 不向任何 Agent 暴露这些写入接口，Hub 执行器拉起的 Agent 子进程同样受此约束。
- **跨模型审查定位（v5 明确约定）**：`codex` / `gemini` / `DeepSeek-V4-Pro` 产出的跨模型审查报告（`reviewReport`）作为人类验收时的强决策辅助信号（标注 `pass / concern / block`），**审查模型本身也不能替代人类点击 `accept` 完成最终验收**；同时单项目内不因执行子进程失败/限流而污染 `.workbench/` 状态机一致性。
- **验收门禁（Acceptance Gate）**：必须满足非阻塞/非取消/非完成、至少定义了 1 条必需验收条件（禁止 `0/0` 直接通过）、且全部必需验收条件在当前 `specHash` 与当前最新 `codeSnapshotHash` 下均为 `passed`。

### 3.5 跨 Harness 上下文交接与方案共创不变量（Context Continuity & Co-Design，v5 新增）
- **仅提问探讨（`ask`）只读无副作用**：`ask` 模式下调用的 Agent 只能向 `discussions[]` 写入问答答复，**严禁改变需求 `stage`、不得覆盖 `spec.md`/`design.md`、也不得使既有 `approval` 失效**。
- **跨模型切换自动现场同步**：每当切换 Harness 或在上一轮 `failed` / `cancelled` / `rateLimited` 后接力重试时，引擎必须基于磁盘权威状态（`spec.md`、`design.md`、`handoffNote`、最新 `observeGitChanges` 真实代码改动、失败 `evidence/` 摘要与未解决 `discussions[]`）重新生成有界 `handoff.md`，确保即使前一模型崩溃未总结也能精准接续，而不转储原始探索噪音。

### 3.6 自进化与 RSI 递归防熔断不变量（Self-Evolution & Anti-Recursion，v5.1 新增）
- **沙箱隔离与合并门禁**：针对 Workbench 自身的痛点转化需求可在 `~/.workbench-hub/evolution/worktrees/<REQ-ID>` 创建独立 Git Worktree 沙箱执行编码与验证；列表/详情/验证必须绑定沙箱工作树快照以防误报过期。**只有完成人类最终验收（`stage === "done"` 且 `acceptance` 快照仍匹配当前沙箱状态）后**，方可执行 `applySandboxToMain` 将改动原子同步回主工作树，并在变更涉及主仓库相同文件时显式报冲突拒绝盲覆写，且严禁路径穿越与符号链接越界。
- **单层递归熔断（`WORKBENCH_RSI_DEPTH=1`）**：在 RSI 沙箱内运行 Subprocess 时强制注入 `WORKBENCH_RSI_DEPTH=1`，且 Hub 后置嗅探器对沙箱需求自动关闭运行异常转工单，杜绝无限自指递归。
- **日志脱敏与有界落盘**：Playbook 经验规则（`deadEnds`、人类 `refine`/已解决批注、打回意见，上限 16KB）及 `inbox.jsonl`（SHA-256 `(category, title, component)` 去重，2MB 上限）均须执行 ANSI 剥离、凭据脱敏与跨进程文件锁原子更新；CLI `wb issue` 与 `wb service` 同样遵循无旁路契约。

---

## 4. 安全边界与输出裁剪

- **输入输出有界**：单次工具载荷、验证日志、`agentRuns` 实时流缓冲与历史日志保留均设明确上限；所有展示与返回日志均执行 ANSI 控制符剥离与常见凭据脱敏（Bearer Token、API Key、私钥块等）。
- **子进程隔离与可控终止**：Hub 执行器拉起的所有 CLI Harness 子进程绑定独立进程组（PGID），支持前端点击「终止」及 Hub 优雅退出时一键清理进程树，防止孤儿进程持续消耗账号额度。
- **诚实边界**：工作台门禁是面向交付流程与多模型协同的工程护栏，通过 Git 快照指纹绑定与独立验证守住事实底线；不擅自更改用户各外部 CLI 的全局账号认证信息，不自动执行 `git commit`、`git push` 或分支合并。
