# 领域模型与存储契约规范（v6 极简 4 态与项目级路由基线）

> 本文定义解耦工作台（`Workbench Core` + `Workbench Hub`）的数据存储格式、4 态流转规则、项目级 3 角色路由契约与不可削弱的工程不变量。产品与架构设计见 [DESIGN.md](DESIGN.md)。

---

## 1. 存储分层结构

工作台严格隔离**“按 Git 项目归属的业务真相与路由配置（`.workbench/`）”**与**“全局 Hub 注册表与轻量遥测台账（`~/.workbench-hub/`）”**：

### 1.1 仓库内项目业务存储（`<projectRoot>/.workbench/`）

项目业务数据统一存储在各自仓库根目录的 `.workbench/` 下，采用 **“可读 Markdown 正文 + 轻量结构化 JSON”** 的混合结构：

```text
.workbench/
├── project.json                  # 项目级元数据 (schemaVersion: 6, projectId, name, nextNumber, privacyMode, routing, outputLanguage?, github?, gitee?, verification?, worktree?)
├── playbook.md                   # 轻量项目经验法则（上限 16KB，勾选沉淀后即时生效于非审查交接简报，不污染业务代码与 Git）
└── items/
    └── REQ-001/
        ├── spec.md               # 需求目标 (Goal) 与范围 (Scope) 的 Markdown 正文
        ├── design.md             # 当前技术方案 (Design) 的 Markdown 正文（支持内联 ```workbench-criteria 与 ```workbench-decisions JSON 块）
        ├── handoff.md            # 高信噪比跨 Harness 上下文交接简报（自动合成，静态前置/动态后置）
        ├── state.json            # schemaVersion: 6 结构化状态（4 态 stage, track, kind, tier, originalGoal, revision, criteria, manualChecks, pendingDecisions, humanDecisions, needsHuman, revisedFromCoding, approval, acceptance, delivery, verifications, discussions, agentRuns, reviewReport, designReviewReport, timeline）
        ├── attachments/          # 附件二进制文件（<attId>.<ext>，元数据只存 state.json）
        ├── history/              # 历史批准过的 spec/design 快照 (如 design.v1.md)，用于版本对比
        ├── evidence/             # 真实运行的验证输出日志与元数据 (如 verify-<id>.json / .log)
        └── runs/                 # 主动调度的 Harness 执行记录：run-<id>.json / .log / .events.jsonl / .context.json
```

- **隐私与 Git 策略**：首次在项目初始化 `.workbench/` 时，由用户选择：
  - **仅本机跟踪（默认推荐）**：自动将 `/.workbench/` 写入本地 `.git/info/exclude`（不修改团队 `.gitignore`）。
  - **随仓库提交**：不修改排除规则，允许将 `.workbench/` 纳入 Git 版本控制与团队审查。
- **一次性显式迁移（Zero Runtime Backward-Compat）**：核心引擎仅接受 `schemaVersion: 6`；历史 v4/v5 项目请运行 `bun run scripts/migrate-v6.ts [--dry-run] <projectRoot>` 完成一次性转换。

### 1.2 全局 Hub 存储（`~/.workbench-hub/`）

多项目统筹、守护进程状态与异步旁路统计存放在用户主目录 `~/.workbench-hub/` 下，绝不污染具体业务仓库的 Git 工作区，且不再存放全局路由配置：

```text
~/.workbench-hub/
├── uploads/<attId>/              # 附件暂存区（TTL 24h 惰性清扫）
├── daemon.json                   # 守护进程元数据 (pid, port, url, startedAt, version)
├── service.json                  # 用户级原生服务安装记录 (LaunchAgent / systemd --user，权限 0600)
├── hub.log                       # 守护进程运行日志（按大小自动轮转截断）
├── hub.json                      # 多项目注册表 + 输出语言 / Gitee Token / 可观测性配置（无 routing 字段）
├── sandboxes.json                # 活跃 Git Worktree 隔离沙箱登记表
├── worktrees/<REQ-ID>/           # 隔离 Git Worktree 沙箱目录
└── telemetry/
    ├── model-stats.json          # 各 Harness/Model 胜率、耗时与限流冷却账本（异步旁路写入）
    └── runs-ledger.jsonl         # 全局执行统计与双轨成本台账（异步旁路写入）
```

`project.json.routing` 核心字段约束（v6）：
- `defaultLead`: `{ primary: ModelTarget, fallbacks: ModelTarget[] }` — 常规需求的主程模型及跨订阅容灾链。
- `sotaLead`: `{ primary: ModelTarget, fallbacks: ModelTarget[] }` — 旗舰攻坚主程模型及容灾链（仅在人工标记 `tier: "sota"` 或点击「升级 SOTA 接管」时使用）。
- `reviewer`: `{ primary: ModelTarget, fallbacks: ModelTarget[] }` — 跨模型独立盲审专家及容灾链。
- `autoReview?`: 布尔值（默认 `true`），验证通过后自动触发一次独立盲审。
- `autoHeal?`: 布尔值（默认 `true`），验证失败后在当前档位内自动触发最多 2 轮修复。

---

## 2. 核心实体与最小数据结构

所有项目 `.workbench/` JSON 文件均包含 `schemaVersion: 6` 与严格的字段校验，未知格式或损坏文件应拒绝覆写并保留原文件供排障。

| 文件 | 核心字段与职责 |
| :--- | :--- |
| `project.json` | `schemaVersion`, `projectId`, `name`, `nextNumber`（单调递增需求编号计数器）, `privacyMode`, `routing`（三角色路由矩阵与自动评审/自愈开关）, `outputLanguage?`（项目级文档输出语言覆盖）, `github?`（`repo`, `autoCreateIssue`, `autoSyncIssue`, `defaultBaseBranch`）, `gitee?`（`repo`, `enterprise`, `defaultBaseBranch`）, `verification?`（`fastCommand`, `fullCommand`, `autoScreenshots`）, `worktree?`（`enabled`, `copyFiles`, `setupScript`）, `createdAt`, `updatedAt`。 |
| `items/REQ-xxx/spec.md` | 需求目标、背景与范围的纯 Markdown 文本；可供人类在任何编辑器直接阅读或提交 Git 审查。 |
| `items/REQ-xxx/design.md` | 当前技术方案 Markdown 文本（`fast_track` 模式下允许为空）。 |
| `items/REQ-xxx/handoff.md`（v5） | 轻量指针型交接简报（8KB 上限，固定语义标题无节序号），提供权威磁盘文件路径（`spec.md`、`design.md`、`evidence/`）、待处理人类批注/最新反馈与最近失败摘要；`review` 阶段自动隔离 Playbook 与增量模式偏见。 |
| `items/REQ-xxx/state.json` | `schemaVersion`, `id` (`REQ-001`), `kind` (`feature \| bug`), `tier` (`standard \| sota`), `title`, `originalGoal`, `stage`, `track`, `revision` (CAS 整数), `specHash`, `designVersion`, `designHash`, `criteria`, `manualChecks?`, `pendingDecisions?`, `humanDecisions?`, `needsHuman?`, `revisedFromCoding?`, `approval`, `acceptance`, `delivery`, `tasks`, `baseline`, `verifications`, `timeline`, `lastFeedback`, `blockedFrom`, `blockedReason`, `handoffNote`, `discussions`, `agentRuns`, `reviewReport`, `designReviewReport?`, `github?`, `attachments?`, `createdAt`, `updatedAt`。 |
| `items/REQ-xxx/attachments/<attId>.<ext>`（v5.2） | 附件二进制独立落盘；`state.attachments` 仅保存 `{ id, name, mimeType, size, sha256, addedAt }`，禁止 base64 内嵌。白名单：图片 `png/jpeg/jpg/gif/webp`，文件 `pdf/txt/md/json/csv/log/zip`；严禁 `svg/html` 与可执行类型。单文件 ≤10MB、单条 ≤8 个、合计 ≤20MB。 |
| `items/REQ-xxx/evidence/verify-<id>.json` & `.log` | 不可变验证证据：包含 `id`, `command`, `cwd`, `criterionIds`, `specHash`, `codeSnapshotHash`, `exitCode`, `timedOut`, `durationMs`, `startedAt`, `endedAt`, `passed`, `outputPath`, `outputPreview`, `truncated`。 |
| `items/REQ-xxx/runs/run-<id>.json` & `.log`（v5） | 主动调度运行记录：`id`, `action` (`ask` \| `design` \| `implement` \| `fix` \| `review`), `dispatchReason?`（含 `auto_heal` 等）, `harness`, `model`, `effectiveModel?`, `modelFallback?`, `reasoningEffort?`, `nativeSessionId?`, `status` (`running` \| `succeeded` \| `failed` \| `cancelled`), `startedAt`, `endedAt`, `exitCode`, `durationMs`, `rateLimited?`, `errorSummary?`, `logPath`。其中 `model` 是请求目标，`effectiveModel` 是 CLI 回报的实际模型，`modelFallback` 表示 CLI 已将请求模型降级。 |

v5 新增在 `state.json` 上的结构（向后兼容旧记录，缺失时默认 `[]` / `null`）：
- `handoffNote`（或 `null`）：结构化交接备忘 `{ updatedAt, keyDecisions: string[], deadEnds: string[], nextSteps: string[] }`，允许 Agent 在 `wb_propose` / `wb_update_tasks` 时沉淀高价值定位与踩坑警示。
- `discussions[]`：需求内段落批注与问答讨论流 `{ id, at, actor: "human" | "agent", mode: "ask" | "refine", anchor?: string, harness?: string, model?: string, message: string, resolved?: boolean }`。
- `agentRuns[]`：记录最近运行摘要 `{ id, action, harness, model, effectiveModel?, modelFallback?, nativeSessionId?, status, startedAt, endedAt, exitCode, durationMs, errorSummary? }`，便于前端重连与同构续接。
- `attachments?`：附件元数据数组 `{ id, name, mimeType, size, sha256, addedAt }`；二进制位于同需求 `attachments/` 目录。已最终验收（`done` 且 `acceptance` 非空）的需求禁止增删附件（返回 409）；痛点转正时附件复制到新需求，并在交接简报中列出绝对路径。
- `reviewReport`（或 `null`）：最新一次编码后跨模型代码审查结果 `{ id, reviewerHarness, reviewerModel, verdict: "pass" | "concern" | "block", summary, markdown, findings?, reviewedSpecHash, reviewedCodeSnapshotHash, reviewedCommit?, reviewerSessionId?, reviewedAt }`；当 `specHash` 或当前代码内容树快照发生变化时标记为 `stale`；若 `verdict === "block"` 且变为 `stale`，跳过复审直接验收同样必须填写 `overrideReason`。
- `designReviewReport`（或 `null`，Flow P3 新增）：独立异构方案评审报告 `{ id, reviewerHarness, reviewerModel, verdict, summary, markdown, findings?, reviewedSpecHash, reviewedDesignHash, reviewedAt }`；严格隔离于编码后的 `reviewReport`，仅随 `specHash`/`designHash` 变动标 `stale`，绝不阻断人类批准也不污染编码阶段审查防线。
- `kind`（`"feature" | "bug"`，存量默认 `"feature"`，Flow P3 新增）：`bug` 类型经人授权后沿用 `fast_track` 单段进入 `coding`，支持编码期「只增不删」追加回归测试验收条件（不作废启动授权，严禁删除或削弱已有条件），自动开启异构代码审查，并支持暂停上报（`needsHuman.source === "bug_pause"`）及保留 `kind: "bug"` 标签转常规方案流程（`track: "plan_first"`）。
- `originalGoal`、`manualChecks`、`pendingDecisions`、`humanDecisions`、`needsHuman`、`revisedFromCoding`（Flow P2 新增）：
  - `originalGoal`：创建时固化的不可变原始需求原话，置顶展示于 `spec.md` 上方。
  - `Criterion.kind === "manual"` + `steps` + `manualChecks[]`：人工核验项绑定 `specHash + codeSnapshotHash`，代码或规范变更后自动过期；`Criterion.systemInjected` 标记系统自动注入的通用基线命令，用于验收页 `fast_track` 诚实告警。
  - `pendingDecisions[]` 与 `humanDecisions[]`（通过 `approval.decisionsHash` 绑定批准）：非 Modal 内嵌决策卡片支持预设直批与打包修订双出口，已采纳决策作为最高权威裁决注入编码/修复/审查上下文。
  - `needsHuman` 与 `revisedFromCoding`：自愈或 1 轮审查修复闭环耗尽后派生 `needs_human` 状态并亮红点；`revisePlan` 仅向人类开放（不暴露给 Agent CLI/MCP），执行 `coding → planning`、作废 `approval` 并将当前 `git diff` 写入 `handoff.md`，重新批准时可选保留或重置沙箱至干净 `baseHead`。
- **内容树快照指纹与 WIP/交付核对（Flow P1/P2 新增）**：代码快照基于 Git 内容树（`sha256("tree:<treeOid>\n")`）剥离 `HEAD` commit hash，沙箱自动 WIP 检查点与历史压缩（squash）只要内容树不变即复用验证与验收结论；交付前校验文件范围与内容树，范围或树变化时阻断直接复用并要求重验；合入本地主干或 PR 合并落地后再清理沙箱，取消含未交付改动时保留沙箱直至人工显式丢弃，并仅自动快进无改动的干净兄弟沙箱（脏沙箱温和标记 `drifted`）。
- **轻量项目经验（`.workbench/playbook.md`）与调优验证（Flow P3 新增）**：人类在打回修改、验收备注或解决重要审查 `block` 时勾选「记住这条项目经验」，原子追加单条精炼规则至 `.workbench/playbook.md`（上限 16KB，不碰业务代码与 Git，后续非审查交接简报即时读取生效）；`scripts/tuning-report.ts` 与 `computeTuningReport` 联合 `runs-ledger.jsonl` 与项目状态，按轨道（`plan_first` / `fast_track` / `bug`）及 Harness 输出调用次数、可观测 Token（缺失显式记为未知）、验收耗时与重开率。

---

## 3. 核心领域不变量（Core Invariants）

以下不变量由 `Workbench Core`（TypeScript/Bun）在领域层强制执行，UI、CLI、MCP Server 与 Hub 调度器共享同一套校验与计算逻辑，不允许任何旁路绕过。

### 3.1 单写者与原子文件更新（Atomic Persistence）
- **统一写入入口**：所有对 `.workbench/` 与 `~/.workbench-hub/` 的状态持久化均通过原子写入流程（同目录临时文件 `.tmp-<uuid>` → `fsync` → `rename`）；`.workbench/` 写入串行化使用进程内队列 + 项目级 `.lock` 文件锁。
- **乐观锁防覆盖（CAS）**：修改 `state.json` 必须校验并递增单调 `revision`。当预期 `revision` 与磁盘当前值不符时拒绝写入并返回冲突详情。
- **路径安全**：所有项目内部文件与 Hub 目录浏览均限制在合法规范目录之内，严禁 `..` 路径穿越或追踪越界符号链接（symlink）。

### 3.2 生命周期枚举与双轨规则
- **持久阶段枚举（4 个清晰状态）**：`planning`、`coding`、`done`、`cancelled`（"待批准"、"验证失败"、"待验收"均由状态派生）。
- **双轨模式（`track: "plan_first" | "fast_track"`）**：
  - **`plan_first`（标准模式）**：必须存在对应当前 `specHash` 与当前 `design.md` 摘要的人工批准记录（`approval`），方可进入 `coding`。当 `spec.md`、`criteria` 或 `design.md` 发生实质修改时，旧批准自动失效并回退至 `planning`。
  - **`fast_track`（快速通道）**：必须由人类在 UI 显式点击授权后方可从 `planning` 直接进入 `coding`，允许无 `design.md`，但仍须绑定需求目标与必需验收条件。
- **终态与重新打开**：`done` 与 `cancelled` 允许人工显式 `reopen`；`cancelled` 记录可选 `cancelReason`。

### 3.3 验证驱动与证据真实性（Verification Truthfulness）
- **禁止口头声明完成**：任何 Agent（无论是通过 MCP、`wb` CLI 还是 `codex`/`qodercn`/`opencode` 子进程）均不得直接将验收条件标为 `passed`。
- **证据三重绑定**：每条 `VerificationRecord` 只能由工作台内置命令执行器真实运行后生成，强制绑定 `specHash`、当前工作区 Git 快照 `codeSnapshotHash` 及真实退出码/日志路径。
- **自动过期检测（Stale Detection）**：代码快照或 `specHash` 一旦变更，旧通过记录实时派生为 `stale`，绝不伪绿。

### 3.4 人工主权边界（Human Sovereignty）
- **不可委托的人类决策**：`approve`（批准方案）、`fast_track`（授权快速通道）与 `accept`（最终验收通过）只能由人类在 Web UI 触发；MCP Server 与 `wb` CLI 不向任何 Agent 暴露这些写入接口，Hub 执行器拉起的 Agent 子进程同样受此约束。
- **跨模型审查定位（v5 明确约定）**：`codex` / `agy`（Antigravity / Gemini CLI） / `DeepSeek-V4-Pro` 产出的跨模型审查报告（`reviewReport`）作为人类验收时的强决策辅助信号（标注 `pass / concern / block`），**审查模型本身也不能替代人类点击 `accept` 完成最终验收**；同时单项目内不因执行子进程失败/限流而污染 `.workbench/` 状态机一致性。
- **验收门禁（Acceptance Gate）**：必须满足非阻塞/非取消/非完成、至少定义了 1 条必需验收条件（禁止 `0/0` 直接通过）、且全部必需验收条件在当前 `specHash` 与当前最新 `codeSnapshotHash` 下均为 `passed`。

### 3.5 跨 Harness 上下文交接与方案共创不变量（Context Continuity & Co-Design，v5 新增）
- **仅提问探讨（`ask`）只读无副作用**：`ask` 模式下调用的 Agent 只能向 `discussions[]` 写入问答答复，**严禁改变需求 `stage`、不得覆盖 `spec.md`/`design.md`、也不得使既有 `approval` 失效**。
- **跨模型切换自动现场同步**：每当切换 Harness 或在上一轮 `failed` / `cancelled` / `rateLimited` 后接力重试时，引擎必须基于磁盘权威状态（`spec.md`、`design.md`、`handoffNote`、最新 `observeGitChanges` 真实代码改动、失败 `evidence/` 摘要与未解决 `discussions[]`）重新生成有界 `handoff.md`，确保即使前一模型崩溃未总结也能精准接续，而不转储原始探索噪音。

### 3.6 自进化与 RSI 递归防熔断不变量（Self-Evolution & Anti-Recursion，v5.1 新增）
- **沙箱隔离与合并/PR 门禁**：项目启用 Worktree 隔离后，在 `~/.workbench-hub/worktrees/<projHash>/<REQ-ID>` 创建独立 Git Worktree 沙箱执行编码与验证；列表/详情/验证必须绑定沙箱工作树快照以防误报过期。**只有完成人类最终验收（`stage === "done"` 且 `acceptance` 快照仍匹配）后**，方可执行人工触发的标准化 GitHub/Gitee PR 交付（在沙箱分支 `feat/<req-id>` 或 `fix/<req-id>` 提交/squash 后 → `git push` → 创建 PR，PR 合并后再执行主干快进并清理沙箱），或执行一键合入本地主干（`mergeSandboxToMain`）或紧急文件应用（`applySandboxToMain`，严禁路径穿越与符号链接越界）。
- **单层递归熔断（`WORKBENCH_RSI_DEPTH=1`）**：在 RSI 沙箱内运行 Subprocess 时强制注入 `WORKBENCH_RSI_DEPTH=1`，且 Hub 后置嗅探器对沙箱需求自动关闭运行异常转工单，杜绝无限自指递归。
- **输出语言与 GitHub 安全边界**：所有调度 Prompt 与 `handoff.md` 按 `project.outputLanguage -> hub.outputLanguage -> "zh-CN"` 解析并强制注入输出语言指令；GitHub 集成完全复用本机已登录的 `gh` CLI 会话（不持久化 PAT），Issue 导入/同步与 PR 推送均在人工操作入口下执行且经过参数白名单与 `sanitizeOutput` 凭据脱敏。
- **日志脱敏与有界落盘**：Playbook 经验规则（由显式 `/api/project/playbook/distill` 或手工确认维护，上限 16KB；`accept` 时不再静默自动污染）及 `inbox.jsonl`（SHA-256 `(category, title, component)` 去重，2MB 上限）、全局执行台账 `~/.workbench-hub/telemetry/runs-ledger.jsonl`（单文件上限 16MB，按需保留最近 20,000 条）与各运行 `run-<id>.events.jsonl`（单次上限 8MB，单工具输入 `<=16KB`、输出头尾保留 `<=32KB`，`rawLog` 头尾保留 `<=4MB`）均须执行 ANSI 剥离、凭据脱敏与跨进程文件锁原子更新；CLI `wb issue` 与 `wb service` 同样遵循无旁路契约。`omp` 聚合调度始终穿透归属底层供应商额度池（如 `openai-codex`、`qoder-cn`、`google-antigravity`、`opencode-go`），`opencode-go` 默认按订阅制归因并记录双轨（实付 vs 订阅等价）成本。

---

## 4. 安全边界与输出裁剪

- **输入输出有界**：单次工具载荷、验证日志、`agentRuns` 实时流缓冲与历史日志保留均设明确上限；所有展示与返回日志均执行 ANSI 控制符剥离与常见凭据脱敏（Bearer Token、API Key、私钥块等）。
- **子进程隔离与可控终止**：Hub 执行器拉起的所有 CLI Harness 子进程绑定独立进程组（PGID），支持前端点击「终止」及 Hub 优雅退出时一键清理进程树，防止孤儿进程持续消耗账号额度。
- **诚实边界**：工作台门禁是面向交付流程与多模型协同的工程护栏，通过 Git 快照指纹绑定与独立验证守住事实底线；不擅自更改用户各外部 CLI 的全局账号认证信息，不向 Agent 暴露任何 `git push`、`gh pr create` 或审批/验收越权接口。
