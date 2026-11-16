# 领域模型与存储契约规范（v4 极简混合存储基线）

> 本文定义新一代解耦工作台（`Workbench Core`）的数据存储格式、状态流转规则与不可削弱的工程不变量。产品与架构设计见 [DESIGN.md](DESIGN.md)，实施任务见 [TASKS.md](TASKS.md)。

---

## 1. 仓库内混合存储结构（`.workbench/`）

借鉴 `OpenSpec` 的人类可读规范与 `Beads` 的轻量状态分离模式，项目业务数据统一存储在仓库根目录的 `.workbench/` 下，采用 **“可读 Markdown 正文 + 轻量结构化 JSON”** 的混合结构：

```text
.workbench/
├── project.json                  # 项目级元数据 (schemaVersion, projectId, name, nextNumber, createdAt)
└── items/
    └── REQ-001/
        ├── spec.md               # 需求目标 (Goal) 与范围 (Scope) 的 Markdown 正文
        ├── design.md             # 当前技术方案 (Design) 的 Markdown 正文
        ├── state.json            # 结构化状态、验收标准与验证命令映射、批准记录、任务清单、时间线事件
        ├── history/              # 历史批准过的 spec/design 快照 (如 design.v1.md)，用于版本对比
        └── evidence/             # 真实运行的验证输出日志与元数据 (如 verify-<id>.json / .log)
```

### 1.1 初始化与版本兼容声明
- **隐私与 Git 策略**：首次在项目初始化 `.workbench/` 时，由用户选择：
  - **仅本机跟踪（默认推荐）**：自动将 `/.workbench/` 写入本地 `.git/info/exclude`（不修改团队 `.gitignore`）。
  - **随仓库提交**：不修改排除规则，允许将 `.workbench/` 纳入 Git 版本控制与团队审查。
- **不兼容旧版数据**：旧版 Tern-Luau 架构存储在 `.omp/workbench/`（及早期 KV/tasks）中的 v1/v2/v3 纯 JSON 数据与双栅栏锁文件**不再读取、不再兼容、不再自动迁移**。新引擎完全独立运行于 `.workbench/`，不删除或破坏用户历史遗留目录。

---

## 2. 核心实体与最小数据结构

所有 JSON 文件均包含 `schemaVersion: 4` 与严格的字段校验，未知格式或损坏文件应拒绝覆写并保留原文件供排障。

| 文件 | 核心字段与职责 |
| :--- | :--- |
| `project.json` | `schemaVersion`, `projectId`, `name`, `nextNumber`（单调递增需求编号计数器）, `createdAt`, `updatedAt`。 |
| `items/REQ-xxx/spec.md` | 需求目标、背景与范围的纯 Markdown 文本；可供人类在任何编辑器直接阅读或提交 Git 审查。 |
| `items/REQ-xxx/design.md` | 当前技术方案 Markdown 文本（`fast_track` 模式下允许为空）。 |
| `items/REQ-xxx/state.json` | `schemaVersion`, `id` (`REQ-001`), `title`, `stage`, `track`, `revision` (CAS 整数), `specHash` (当前规范与条件摘要 SHA-256), `designVersion`, `criteria` (`[{id, description, required, command?}]`), `approval`, `tasks` (`[{id, title, status, note?}]`), `baseline`, `verifications` (索引摘要), `timeline`, `blockedFrom`, `blockedReason`, `createdAt`, `updatedAt`。 |
| `items/REQ-xxx/evidence/verify-<id>.json` & `.log` | 不可变验证证据：包含 `id`, `command`, `cwd`, `criterionIds`, `specHash`, `codeSnapshotHash`, `exitCode`, `timedOut`, `durationMs`, `startedAt`, `endedAt`, `outputPath`, `truncated`。 |

---

## 3. 核心领域不变量（Core Invariants）

以下四组不变量由 `Workbench Core`（TypeScript/Bun）在领域层强制执行，UI、CLI、MCP Server 与会话适配器均共享同一套校验与计算逻辑，不允许任何旁路绕过。

### 3.1 单写者与原子文件更新（Atomic Persistence）
- **统一写入入口**：所有对 `.workbench/` 的创建与更新均经过 `Workbench Core` 引擎执行；本地通过进程内队列与文件锁串行化单项目写入，彻底消除跨 OS / PowerShell 异步竞态。
- **原子落盘**：采用同目录临时文件（`.tmp-<uuid>`）→ `fsync` → `rename` 原子替换目标文件。
- **乐观锁防覆盖（CAS）**：修改 `state.json` 必须校验并递增单调 `revision`。当预期 `revision` 与磁盘当前值不符时拒绝写入，返回冲突详情与最新内容供调用方合并或重读，绝不采用静默“最后写入覆盖”。
- **路径安全**：所有读写必须限制在项目规范根目录（canonical root）之内，拒绝包含 `..` 或指向目录外的符号链接（symlink）。

### 3.2 生命周期枚举与双轨规则
- **持久阶段枚举（8 个清晰状态）**：
  - `draft`（草稿/待整理）
  - `designing`（Agent 正在编写规范与方案）
  - `awaiting_approval`（方案已提交，等待人工批准）
  - `implementing`（正在实施与验证）
  - `awaiting_acceptance`（已提交交付，等待人工验收）
  - `done`（已验收完成）
  - `blocked`（受阻，保留 `blockedFrom` 与 `blockedReason`）
  - `cancelled`（已取消）
- **双轨模式（`track: "plan_first" | "fast_track"`）**：
  - **`plan_first`（标准模式）**：必须存在对应当前 `specHash` 与当前 `design.md` 摘要的人工批准记录（`approval`），方可进入 `implementing`。当 `spec.md`、`criteria` 或 `design.md` 发生实质修改时，旧批准自动失效并回退至 `awaiting_approval`。
  - **`fast_track`（快速通道）**：必须由人类在 UI 显式点击「快速通道：直接实施」授权后，方可从 `draft` 直接进入 `implementing`，允许无 `design.md`，但仍须绑定需求目标与必需验收条件。
- **终态与阻塞保护**：
  - 进入 `blocked` 必须记录非空原因并保存 `blockedFrom`；解除阻塞后恢复原阶段，不复活已失效的批准或证据。
  - `done` 与 `cancelled` 为终态；允许人工显式 `reopen` 重开回 `draft`（或 `implementing`），历史批准与历史验收记录保留在 `timeline` 中，不作为当前有效批准或验收。

### 3.3 验证驱动与证据真实性（Verification Truthfulness）
- **禁止口头声明完成**：Agent 的对话回复或 `wb_update_tasks` 工具参数绝不允许直接将验收条件标为 `passed`。
- **证据三重绑定**：每一条 `VerificationRecord` 只能由工作台内置命令执行器（`runner`）真实运行后生成，并强制绑定以下三项要素：
  1. 执行时的需求规范与条件摘要（`specHash`）；
  2. 执行结束时的工作区 Git 快照指纹（`codeSnapshotHash`，综合当前 `HEAD`、工作区脏状态与已追踪/未追踪变更哈希）；
  3. 真实退出码（`exitCode`）、是否超时（`timedOut`）及实际终端输出日志路径。
- **自动过期检测（Stale Detection）**：
  - 读取与渲染有效性（`validity.ts`）采用纯函数实时计算。
  - 当工作区代码在验证后继续发生变化（当前 Git 快照指纹 ≠ 证据记录的 `codeSnapshotHash`），或需求规范/验收条件被修改（当前 `specHash` ≠ 证据记录的 `specHash`）时，原有的 `passed` 证据**自动派生为 `stale（已过期，需重跑验证）`**，UI 与门禁绝不将其显示为当前绿色通过。
  - 历史 `failed` 或 `timedOut` 记录不会被自动隐藏或涂绿。

### 3.4 人工主权边界（Human Sovereignty）
- **不可委托的人类决策**：`approve`（批准方案）、`fast_track`（授权快速通道）与 `accept`（最终验收通过）只能由人类在工作台 UI 触发；MCP Server 与 `wb` CLI 不向 Agent 暴露这些写入接口。
- **验收门禁（Acceptance Gate）**：人类点击「验收通过（Mark as Done）」或 Agent 请求推入 `awaiting_acceptance` 时，领域层必须实时重算并同时满足以下全部条件：
  1. 需求处于非 `blocked` / 非 `cancelled` / 非 `done` 状态；
  2. 至少定义了 **1 条**必需验收条件（`required === true`）——明确禁止“零条件 `0/0` 直接通过”；
  3. **所有必需验收条件**在当前 `specHash` 与当前最新 `codeSnapshotHash` 下，均存在至少一条状态为 `passed` 且未过期的验证证据。

---

## 4. 安全边界与输出裁剪

- **输入输出有界**：单次工具调用载荷、验证日志文件大小及返回给 Agent 的日志摘录均设明确上限（如日志摘录截断并提示完整日志路径）；返回给 Agent 的输出默认移除 ANSI 控制符并遮蔽常见凭据模式（Bearer Token、API Key、私钥块等）。
- **诚实边界**：工作台门禁是面向研发交付的**流程与证据护栏**，而非操作系统级沙箱（工作台无法阻止同一宿主机上运行的 Agent 进程通过自身原生 Bash 工具修改文件）。工作台通过绑定真实 Git 快照确保“只要代码动过，未在最新快照下重跑的验证一律标为过期”，以此守住交付事实的底线。
