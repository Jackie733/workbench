# 新一代工作台实施任务清单（WB-01 – WB-24）

> 唯一实施进度入口。设计规范见 [DESIGN.md](DESIGN.md)，目标流程规范见 [FLOW.md](FLOW.md)，领域与存储契约见 [DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md)，产品入口见 [英文 README](../README.md) 与 [中文 README](../README.zh-CN.md)。旧版 Tern-Luau 单体架构及 `AF-01–AF-16` 任务记录已归档至 [archive/2026-11-16/TASKS.md](archive/2026-11-16/TASKS.md)，不继承旧版未完成的包袱。

---

## 执行规则

- `[ ]` 表示未完成；`[x]` 仅在全部交付物落盘、自动化测试及端到端验证通过后勾选，并附带实际运行命令、测试统计与遗留边界。
- **单一技术栈**：除极薄展示/启动入口外，核心引擎、工具接口与服务端统一使用 **TypeScript / Bun** 开发与测试，不再新增 Luau 或 PowerShell 逻辑。
- **单一事实来源**：UI、CLI、MCP Server 与 `omp` 桥接适配器必须调用同一套 `src/core/` 领域校验与状态引擎，不允许写第二套校验逻辑。
- **验证驱动收口**：所有测试必须真实运行并观察到全部用例通过，不得用局部运行或 mock 替代端到端闭环验证。

---

## 任务概览与依赖关系

| 任务编号 | 名称 | 前置依赖 | 目标模块 |
| :--- | :--- | :--- | :--- |
| **WB-01** | 核心存储与领域引擎 | 无 | `src/core/` |
| **WB-02** | Git 观察器与真实验证执行器 | WB-01 | `src/core/git.ts`, `src/core/runner.ts` |
| **WB-03** | 通用 Agent 工具层：CLI 与 MCP Server | WB-01, WB-02 | `src/cli/`, `src/mcp/` |
| **WB-04** | 本地 HTTP/WS 服务与会话桥接适配器 | WB-01, WB-02 | `src/server/`, `omp/` |
| **WB-05** | 极简零废话 Web UI：全局首页与看板 | WB-04 | `src/web/` |
| **WB-06** | 极简零废话 Web UI：需求工作区与拍板闭环 | WB-04, WB-05 | `src/web/` |
| **WB-07** | 清理旧版 Luau/PowerShell 包袱与收口验收 | WB-03, WB-06 | 全仓库清理、文档与端到端回归 |
| **WB-08** | 全局常驻守护进程与多项目注册中心（Phase 2） | WB-07 | `src/hub/registry.ts`, `src/cli/`, `src/server/` |
| **WB-09** | 多 Harness 自动探测与分阶段模型路由矩阵（Phase 2） | WB-08 | `src/hub/discovery.ts`, `src/hub/routing.ts` |
| **WB-10** | 主动式多 Agent 调度执行器与跨模型审查（Phase 2） | WB-09 | `src/hub/executor.ts`, `src/mcp/`, `src/core/` |
| **WB-11** | 三栏式 Web UI 重构（上）：侧边栏、目录浏览与路由中心 | WB-08, WB-09 | `src/web/` |
| **WB-12** | 三栏式 Web UI 重构（下）：模型选择器、审查视图与实时终端 | WB-10, WB-11 | `src/web/`, 全量与 Chromium E2E |
| **WB-13** | Worktree 默认隔离、环境引导、目录读写锁与 WIP 检查点（Flow P1） | WB-12 | `src/core/worktree.ts`, `src/core/git.ts`, `src/core/runner.ts`, `src/hub/executor.ts` |
| **WB-14** | 审查 `block` 自动闭环（封顶 1 轮）与过期 `block` 硬防线（Flow P1） | WB-13 | `src/core/validity.ts`, `src/core/engine.ts`, `src/hub/executor.ts`, `src/hub/post_run.ts` |
| **WB-15** | 增量复审（`lastReviewCommit..HEAD`）与同模型原生续接（Flow P1） | WB-13, WB-14 | `src/core/types.ts`, `src/hub/handoff.ts`, `src/hub/executor.ts`, `src/hub/harness_cmd.ts`, `src/web/` |
| **WB-16** | Prompt 缓存友好排序、编码容错与环境失败分流（Flow P1） | WB-13 | `src/hub/prompt.ts`, `src/hub/handoff.ts`, `src/hub/executor.ts`, `src/hub/post_run.ts` |
| **WB-17** | 方案阶段 Prompt 内联、单次提交与无关全局配置隔离（Flow P2） | WB-16 | `src/hub/prompt.ts`, `src/hub/handoff.ts`, `src/hub/harness_cmd.ts`, `src/hub/post_run.ts` |
| **WB-18** | `manual` 验收条件、置顶 `originalGoal` 与决策卡片双出口（Flow P2） | WB-17 | `src/core/`, `src/hub/post_run.ts`, `src/server/`, `src/web/` |
| **WB-19** | `revisePlan` 人工回退流转与自愈耗尽 `needs_human` 升级（Flow P2） | WB-13, WB-16 | `src/core/engine.ts`, `src/core/worktree.ts`, `src/core/validity.ts`, `src/server/`, `src/web/` |
| **WB-20** | 默认沙箱一键交付双出口（自动 squash）与多沙箱联动（Flow P2） | WB-13 | `src/core/engine.ts`, `src/core/worktree.ts`, `src/core/git.ts`, `src/server/`, `src/web/` |
| **WB-21** | `kind: feature \| bug` 分流与 Bug 单段修复闭环（Flow P3） | WB-14, WB-19 | `src/core/`, `src/hub/executor.ts`, `src/hub/prompt.ts`, `src/server/`, `src/web/` |
| **WB-22** | 按需异构方案评审（独立存储与非阻断审批）（Flow P3） | WB-18 | `src/core/`, `src/hub/executor.ts`, `src/hub/prompt.ts`, `src/server/`, `src/web/` |
| **WB-23** | `fast_track` 诚实标示与验收页 4 要素收口（Flow P3） | WB-18, WB-20, WB-21 | `src/core/validity.ts`, `src/web/` |
| **WB-24** | 轻量经验沉淀（`playbook.md`）、文档对齐与调优验证（Flow P3） | WB-20, WB-21, WB-22, WB-23 | `src/core/engine.ts`, `src/hub/ledger.ts`, `src/web/`, `docs/` |

---

## 任务明细

### [x] WB-01 核心存储与领域引擎 (`src/core/`)

- **设计映射**：[DESIGN.md](DESIGN.md) §2.1, §4；[DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md) §1–§3。
- **交付物**：
  - 建立纯 TypeScript / Bun 的 `.workbench/` 混合存储读写器（`project.json`、`items/REQ-xxx/spec.md`、`design.md`、`state.json`、`history/`、`evidence/`）。
  - 实现基于同目录临时文件 + `fsync` + `rename` 的原子写入、单项目进程内写入串行锁与 `state.json` 的 `revision` CAS 乐观锁。
  - 实现项目初始化（支持写入 `.git/info/exclude` 仅本机排除或随 Git 跟踪）、编号分配、双轨流转（`plan_first` / `fast_track`）、阻塞/解除/取消/重开、以及 `validity.ts`（批准有效性、证据过期计算、零条件拦截与验收门禁）。
  - 落实目录穿越与符号链接校验。
- **验收标准**：
  - `bun test` 单元测试完整覆盖项目初始化、需求创建与 CAS 冲突拒绝、双轨流转（标准方案批准 vs 快速通道）、内容/方案修改使旧批准失效、代码/规范漂移使旧验证失效、零必需条件被验收门禁拦截等全部场景。
- **执行记录（WB-01 已完成，2026-11-16）**：
  - 新增 `package.json`、`tsconfig.json`、`src/types/omp.d.ts` 及 `src/core/{errors,types,fs,validate,validity,store,engine}.ts`。
  - 实测 `bun test tests/core/engine.test.ts`：8 pass、0 fail、70 expects；`bun run typecheck`（`tsc --noEmit`）通过（0 errors）。

---

### [x] WB-02 Git 观察器与真实验证执行器 (`src/core/git.ts`, `src/core/runner.ts`)

- **前置依赖**：WB-01。
- **设计映射**：[DESIGN.md](DESIGN.md) §2.1, §3.2, §4；[DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md) §3.3, §4。
- **交付物**：
  - `src/core/git.ts`：原生采集仓库 `HEAD`、工作区变更文件列表、Unified Diff（支持截断保护）以及综合已追踪与未追踪文件内容的稳定工作区快照指纹（`codeSnapshotHash`）。
  - `src/core/runner.ts`：在项目根目录执行真实验证命令（支持可配置超时与输出大小上限、ANSI 清理与常见凭据脱敏），自动采集退出码与当前 `codeSnapshotHash`，落盘不可变的 `evidence/verify-<id>.json` 与 `.log`，并更新对应 `state.json` 的验证索引。
- **验收标准**：
  - 在隔离的真实临时 Git 仓库中完成测试：脏工作区快照指纹随文件改动确定性变化；Diff 采集准确；命令通过、命令非零退出、超时均能正确落盘证据；测试通过后再改动工作区代码，既有 `passed` 证据自动被评估为 `stale`。
- **执行记录（WB-02 已完成，2026-11-16）**：
  - 新增 `src/core/git.ts` 与 `src/core/runner.ts`，实现排除 `.workbench/` 的稳定工作区快照指纹、已追踪/未追踪文件 Diff 与提交采集、同命令分组验证执行器、超时强杀、输出脱敏与不可变证据落盘。
  - 实测 `bun test tests/core/`：12 pass、0 fail、110 expects；`bun run typecheck` 通过。覆盖非 Git 目录降级、未提交/提交后快照、无提交仓库、失败/超时/脱敏证据及改代码后证据自动标为 `stale`。

---

### [x] WB-03 通用 Agent 工具层：CLI 与 MCP Server (`src/cli/`, `src/mcp/`)

- **前置依赖**：WB-01, WB-02。
- **设计映射**：[DESIGN.md](DESIGN.md) §2.1, §4；[DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md) §3.4, §4。
- **交付物**：
  - 实现简洁的 `wb` CLI（支持 `--json` 机器输出，覆盖项目初始化、需求查看、方案提交、任务更新与验证执行）。
  - 实现标准 MCP Server（stdio / 本地传输），向任意 Agent（`omp`、Claude Code、Codex CLI、Cursor、OpenCode 等）暴露 5 个正交工具：`wb_list`、`wb_get`、`wb_propose`、`wb_update_tasks`、`wb_verify`。
  - 确保工具层共享 `src/core/` 校验与输出脱敏，绝不暴露 `approve`、`fast_track`、`accept` 接口，也不允许工具直接传入 `passed=true` 伪造验证结果。
- **验收标准**：
  - CLI 与 MCP 协议端到端集成测试通过：模拟 Agent 调用工具完成需求拉取、提交 `spec`/`design`/验收条件、更新实施任务、触发真实测试命令并推进到 `awaiting_acceptance`；验证未通过时请求推入 `awaiting_acceptance` 被拒绝；Agent 越权动作被拒。
- **执行记录（WB-03 已完成，2026-11-16）**：
  - 新增 `src/mcp/tools.ts`、`src/mcp/server.ts`、`src/cli/index.ts`，提供 `wb` CLI（`init`/`list`/`get`/`create`/`propose`/`tasks`/`verify`/`mcp`）与标准 stdio MCP Server（兼容 NDJSON 与 Content-Length 帧），暴露 5 个正交工具并严禁 `approve`/`accept` 越权接口及 `passed=true` 参数伪造。
  - 实测 `bun test tests/core/ tests/mcp/`：15 pass、0 fail、137 expects；`bun run typecheck` 通过。覆盖真实 stdio 子进程 MCP 握手与工具全闭环、真实 CLI `--json` 流程及越权拒绝。

---

### [x] WB-04 本地 HTTP/WS 服务与会话桥接适配器 (`src/server/`, `omp/`)

- **前置依赖**：WB-01, WB-02。
- **设计映射**：[DESIGN.md](DESIGN.md) §2.1, §4.2。
- **交付物**：
  - `src/server/`：基于 Bun 启动轻量本地 HTTP + WebSocket 服务，提供需求 CRUD、批准、快速通道授权、阻塞/取消/重开、人工验收、验证触发、Git Diff 读取等 REST API，并通过 WebSocket 将 `.workbench/` 状态变更与命令执行进度实时推送给前端。
  - `omp/`：精简重写 `omp/index.ts`（目标 ~150 行），去除旧版复杂的 `handoff.ts` 预览令牌与繁琐协议，负责 `/wb` 唤起本地服务/打开工作台 URL、向本地服务同步当前绑定 `omp` 会话的在线与忙闲状态，以及接收来自工作台按钮的一键提示词投递（已有未发送草稿或正忙时不强行覆盖/插话）。
- **验收标准**：
  - 服务端 API 与 WebSocket 实时广播回归测试通过；`omp` 适配器单元测试验证会话绑定、`/wb` 启动与空闲/忙碌/草稿冲突下的安全投递行为。
- **执行记录（WB-04 已完成，2026-11-16）**：
  - 新增 `src/server/{index,prompts,runtime}.ts` 与 `wb serve` 命令，提供完整 REST API、`.workbench/` 文件监听与 WebSocket 实时广播、以及结构化任务提示词生成与离线回退提示词返回。
  - 重写 `omp/index.ts`（162 行），原生注册 5 个 `wb_*` 工具、`/wb` 后台服务唤起与 WS 会话桥接，落实空闲/忙碌/草稿冲突/会话一致性安全投递守卫。
  - 实测 `bun test tests/server/server_bridge.test.ts`：4 pass、0 fail、46 expects；`bun run typecheck` 通过。

---

### [x] WB-05 极简零废话 Web UI：全局首页与看板 (`src/web/`)

- **前置依赖**：WB-04。
- **设计映射**：[DESIGN.md](DESIGN.md) §1.1(4), §3.1。
- **交付物**：
  - 构建参考 Linear / Vibe Kanban 风格的本地 Web UI 首页：
    - 紧凑顶栏（项目名、Agent 连接指示灯、搜索框、范围切换 `活跃 | 已完成 | 全部`、视图切换 `列表 | 看板`、`+ 新建需求`）。
    - 动态置顶「待你拍板（Needs Your Decision）」区（无待办时自动隐藏）。
    - 极简列表视图与四列只读看板（`准备中` / `执行中` / `待验收` / `已完成`，受阻需求集中提示）。
    - 极简新建需求弹窗（单个目标输入框 + `[创建并让 Agent 整理方案]` / `[仅保存草稿]`）及首次进入未初始化项目的初始化引导（选择本机排除或 Git 跟踪）。
    - 优雅支持亮色/暗色主题切换与窄窗口响应式布局。
- **验收标准**：
  - 真实浏览器访问本地服务验证：首页零 UUID / SHA-256 / 免责小字噪声；搜索、筛选、列表与四列看板切换、滚动位置保持、新建需求与初始化流程交互顺畅。
- **执行记录（WB-05 已完成，2026-11-16）**：
  - 新增 `src/web/{index.html,styles.css,render.ts,api.ts,app.ts}`，实现紧凑顶栏、Agent 在线/忙闲指示灯、实时搜索与恢复、范围与列表/四列只读看板切换、动态「待你拍板」置顶区、极简一句话新建弹窗、初始化引导与亮/暗主题。
  - 实测 `bun test tests/web/render.test.ts tests/web/e2e_browser.test.ts`（真实 headless Chromium 1234）：覆盖初始化、22 条列表搜索/清除、返回列表滚动位置恢复（误差 < 20px）、四列看板、暗色主题、375px 窄屏无横向溢出及零内部哈希/免责噪声。

---

### [x] WB-06 极简零废话 Web UI：需求工作区与拍板闭环 (`src/web/`)

- **前置依赖**：WB-04, WB-05。
- **设计映射**：[DESIGN.md](DESIGN.md) §1.1, §3.2。
- **交付物**：
  - 实现需求工作区详情页：
    - 紧凑单顶栏（`← 工作`、`编号`、`标题`、`状态徽章`、`⋯ 更多` 菜单）。
    - **动态决策横幅（Action Banner）**：根据当前状态与门禁实时展示一句话现状与唯一推荐主按钮，覆盖草稿触发 Agent、批准方案并开始实施、快速通道授权、重跑失效验证、验收通过/打回修改。
    - 三个平行内容页签（无二级嵌套 Tab）：
      1. **规范与方案**：完整 Markdown 渲染、`spec.md` 轻量编辑、带实时验证状态的验收条件清单、技术方案 Markdown 及历史版本对比。
      2. **变更与验证**：实施任务清单实时进度、验证命令证据卡片（可展开查看终端输出并一键重跑）、带文件树的语法高亮 Git Diff 视图。
      3. **时间线**：面向人类的时间线事件流。
- **验收标准**：
  - 在真实浏览器 + 隔离项目上完整走通两条端到端闭环：
    1. **Plan-First 标准闭环**：「一句话新建需求 → Agent 调用工具撰写方案与验收条件 → 人工审阅并批准 → Agent 实施并运行真实测试 → 人工审阅 Diff 与测试证据 → 验收通过」；
    2. **Fast-Track 快速通道闭环**：「新建需求 → 人类启用快速通道直接实施 → Agent 编码并运行真实测试 → 人工验收通过」；
  - 验证“改动代码后未重跑验证时禁止验收通过”及“零必需条件禁止验收通过”门禁在 UI 与后端均生效。
- **执行记录（WB-06 已完成，2026-11-16）**：
  - 实现需求工作区单顶栏（`← 工作` + `⋯ 更多`）、动态唯一主操作横幅（Action Banner）、三个平行页签（`规范与方案` / `变更与验证` / `时间线`）、GFM Markdown 与 XSS 安全渲染、方案版本差异对比、内联规范/条件编辑、可展开终端日志、文件树 Git Diff 视图与离线提示词回退弹窗。
  - 实测 `bun test tests/web/e2e_browser.test.ts`（真实 Chromium + 真实 Git 仓库 + 真实 Agent 工具调用 + WebSocket 实时推送）：完整走通 `Plan-First` 闭环、`Fast-Track` 闭环、改代码后验证自动过期拦截及零必需条件（0/0）409 门禁拦截，0 page errors。

---

### [x] WB-07 清理旧版 Luau/PowerShell 包袱与收口验收

- **前置依赖**：WB-03, WB-06。
- **设计映射**：[DESIGN.md](DESIGN.md) §2, §5。
- **交付物**：
  - 清理旧版强耦合实现：`host.luau`、`window.luau`、`styles.css`、`lib/*.luau`、`tests/*.luau` 与旧版 `omp/handoff.ts`（如需保留 Tern 侧打开本地 Web URL 的最小快捷入口，仅保留不超过百行的轻量插件壳或明确移除 `plugin.toml`）。
  - 梳理并更新 `package.json` 脚本、`README.md`、`CHANGELOG.md`，确保 MCP 配置示例与 CLI 使用指南准确可用。
  - 执行全量 `bun test`、TypeScript 类型检查与真实端到端回归测试。
- **验收标准**：
  - 仓库收敛为干净统一的 TypeScript / Bun 架构；无失效文档链接与旧版残留冗余逻辑；全量测试与类型检查 100% 通过。
- **执行记录（WB-07 已完成，2026-11-16）**：
  - 已通过 `git rm` 彻底移除旧版 Tern-Luau 入口与测试资产（`host.luau`、`window.luau`、`styles.css`、`plugin.toml`、`lib/*.luau`、`tests/*.luau`、`tests/native-capabilities/*`、`tests/af-*`、`omp/handoff*`、`omp/runtime*`、`omp/tern.ts`），并将旧版规范归档至 [docs/archive/2026-11-16/](archive/2026-11-16/) 与 [docs/archive/README.md](archive/README.md)。
  - 已收敛 `package.json`、`tsconfig.json`、`README.md`、`CHANGELOG.md`，统一为单栈 TypeScript / Bun（`src/core/` + `src/mcp/` + `src/cli/` + `src/server/` + `src/web/` + `omp/index.ts`）。
  - 实测全量 `bun test`（6 个测试文件，24 pass，0 fail，217 expects，含真实 Chromium E2E 与真实 stdio MCP 子进程）、`bun run typecheck`（`tsc --noEmit` 0 errors）、`bun run wb --help` 与全部 Markdown 文档链接校验（6 份文档 0 broken links）均 100% 通过。

---

## Phase 2：Workbench Hub 多项目中心、多 Harness 路由与三栏式指挥舱升级（WB-08 – WB-12）

### [x] WB-08 全局常驻守护进程与多项目注册中心 (`src/hub/registry.ts`, `src/cli/`, `src/server/`)

- **前置依赖**：WB-07。
- **设计映射**：[DESIGN.md](DESIGN.md) §1.1(5), §2.1, §3.2(1)；[DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md) §1.2, §3.1。
- **交付物**：
  - 将 `wb` CLI 全局安装入口打通（`bun link` / `~/.local/bin/wb` 可在任意目录直接执行），新增守护进程管理子命令：`wb start [--port 4318]`、`wb stop`、`wb restart`、`wb status`、`wb open`。
  - 实现 `~/.workbench-hub/daemon.json`、`hub.log` 与 `~/.workbench-hub/hub.json` 的原子持久化管理，支持多项目注册、移除、活跃项目切换及跨会话记忆。
  - 升级 HTTP/WS 服务端为多项目 Hub 模式：新增 `/api/hub/projects`（增删切换初始化）、`/api/fs/browse`（受路径安全边界约束的本机目录浏览器），并兼容按项目隔离的 `.workbench/` 路由与 `fs.watch` 实时推送。
- **验收标准**：
  - `wb start` 后可在后台稳定常驻，`wb status` 返回正确 PID/URL/纳管项目数，`wb stop` 干净退出无残留进程；通过 API 添加两个独立临时 Git 仓库并切换操作，项目数据与文件监听完全隔离不串扰。
- **执行记录（WB-08 已完成，2026-11-16）**：
  - 新增 `src/hub/types.ts`、`src/hub/registry.ts` 与 `src/cli/daemon.ts`，通过 `bun link` 注册全局 `wb`（`/home/jackie/.bun/bin/wb`），升级 `src/cli/index.ts` 与 `src/server/index.ts` 为多项目 Hub 守护进程模式（`~/.workbench-hub/{daemon.json,hub.json,hub.log}` + `/api/hub/*` + `/api/fs/browse`）。
  - 实测 `tests/hub/hub.test.ts`（WB-08 两项用例）：双 Git 仓库独立隔离切换、安全目录浏览器、真实后台守护进程启动/状态查询/优雅终止全部通过。

---

### [x] WB-09 多 Harness 自动探测引擎与分阶段模型路由矩阵 (`src/hub/discovery.ts`, `src/hub/routing.ts`)

- **前置依赖**：WB-08。
- **设计映射**：[DESIGN.md](DESIGN.md) §2.2, §2.3；[DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md) §1.2。
- **交付物**：
  - 实现本机 Harness 与模型目录自动探测器（`discovery.ts`）：检测 `codex`（解析 `~/.codex/models_cache.json` 与 `config.toml`）、`qodercn`（执行 `qodercn --list-models` 与 `~/.qoder-cn/settings.json`）、`opencode`（执行 `opencode models` 与 auth provider 状态）、`gemini`（兼容 PATH 及 `mise x node@24.4.1 -- gemini`）及 `omp`（读取 `~/.omp/agent/config.yml`）。
  - 实现分阶段路由引擎（`routing.ts`）：支持 `design`、`implement`、`fix`、`review` 四个阶段配置主模型、推理强度（如 Codex `reasoning_effort`）与备援链；内置 `balanced`（推荐默认）、`sota_first`、`quota_saver` 三套策略预设并支持用户自定义扩展模型与单阶段覆写。
  - 新增 Hub API：`/api/hub/harnesses`（查询与刷新探测结果）、`/api/hub/routing`（读取/保存预设与阶段路由矩阵）。
- **验收标准**：
  - 在真实宿主机或模拟 CLI fixture 环境下准确识别各 Harness 可用性与模型列表（失败或未安装时优雅降级不崩溃）；预设切换与自定义模型持久化测试 100% 通过。
- **执行记录（WB-09 已完成，2026-11-16）**：
  - 新增 `src/hub/discovery.ts`（含零阻塞 `discoverHarnessesQuick` 与全量 CLI 探测 `discoverHarnesses`）与 `src/hub/routing.ts`（`balanced` / `sota_first` / `quota_saver` 三套预设、优先级路由解析及 429/限流关键词识别）。
  - 实测 `tests/hub/hub.test.ts`（WB-09 两项用例）：未安装降级、自定义模型合并、预设切换与候选备援排序 100% 通过。

---

### [x] WB-10 主动式多 Agent 调度执行器、上下文交接协议与跨模型审查 (`src/hub/executor.ts`, `src/mcp/`, `src/core/`)

- **前置依赖**：WB-09。
- **设计映射**：[DESIGN.md](DESIGN.md) §2.1, §2.2, §2.4, §2.5；[DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md) §2, §3.4, §3.5, §4。
- **交付物**：
  - 实现跨 Harness 非交互执行器（`executor.ts`）：根据用户选择或阶段路由自动生成 `codex` / `qodercn` / `opencode` / `gemini` / `omp` 启动命令（同 Harness 且存在 `nativeSessionId` 时优先原生 `--resume` / `--session` 续接），并在子进程环境变量中注入 `wb` CLI 路径。
  - 实现 **双层上下文交接包合成器（`handoff.ts`）**：切换 Harness 或上一轮中途失败/限流中断时，自动整合 `spec.md`、`design.md`、`handoffNote`（关键决策与死胡同标记）、真实 `git status / diff` 代码现场、最新失败证据及未解决 `discussions[]` 生成有界 `handoff.md`（1.5k–3k Tokens 预算）。
  - 实现基于进程组（PGID）的实时日志流（WebSocket `agent.run.output` / `agent.run.status`）、凭据脱敏、强制终止（Kill）及额度耗尽/限流关键词识别（触发备援模型一键接力重试）。
  - 扩展 `src/core/` 与 `src/mcp/tools.ts`：支持保存 `agentRuns`、`handoffNote`、`discussions[]`（含 `ask` 只读问答探讨与 `refine` 批注修订两模式）及人类直接编辑 `design.md`；新增跨模型代码审查能力（`reviewReport`：`pass | concern | block`，绑定当前 `specHash` 与 `codeSnapshotHash` 且严禁绕过人类 `accept`）。
- **验收标准**：
  - Mock CLI 与真实子进程集成测试通过：验证同构原生续接、跨 Harness 自动合成 `handoff.md`（含前一进程中途 Kill 后的脏工作区恢复）、`ask` 模式零副作用、`refine` 批量批注修订、进程组强杀、限流识别及审查报告随代码变更自动标为 `stale`。
- **执行记录（WB-10 已完成，2026-11-16）**：
  - 新增 `src/hub/handoff.ts` 与 `src/hub/executor.ts`，扩展 `src/core/{types,validate,store,validity,engine}.ts`、`src/mcp/tools.ts` 与 `wb review` CLI，落地 `handoff.md` 合成、`ask`/`refine` 讨论、直接编辑 `design.md`、PGID 强杀及跨模型审查报告落盘。
  - 实测 `tests/hub/hub.test.ts`（WB-10）：验证 `ask` 零副作用问答、同 Harness `nativeSessionId` 续接、限流识别 + 备援模型切换 + 脏代码现场注入、PGID 取消及 `reviewReport` 随代码修改自动标为 `stale`。

---

### [x] WB-11 三栏式 Web UI 重构（上）：多项目侧边栏、目录浏览器与算力路由中心 (`src/web/`)

- **前置依赖**：WB-08, WB-09。
- **设计映射**：[DESIGN.md](DESIGN.md) §1.1(4)(5), §3.1, §3.2(1)。
- **交付物**：
  - 重构拆分 `src/web/` 前端模块与现代 CSS 设计系统（统一间距、层级、暗/亮色 Token 与窄屏响应式抽取逻辑），彻底告别单文件巨型渲染堆砌。
  - 实现 **左栏（Sidebar）**：多项目实时切换（显示待拍板计数角标、活跃执行呼吸灯）、**「+ 添加项目」安全目录浏览与初始化弹窗**、以及各 Harness 在线指示列表。
  - 实现 **「算力与模型路由中心」配置弹窗**：一键切换 `balanced | sota_first | quota_saver` 策略预设，直观调整设计/实施/修复/审查四阶段的首选模型与备援链，查看各模型目录标签并支持补充自定义模型与手动重探。
- **验收标准**：
  - 在真实无头 Chromium 中完成添加/初始化多个项目并实时切换（无状态串扰）、目录浏览导航、策略预设切换与自定义模型保存回显，无 console/page errors，移动端/窄屏无横向溢出。
- **执行记录（WB-11 已完成，2026-11-16）**：
  - 拆分重构为 `src/web/{api,render,state,app,styles.css}` 与 `src/web/views/{sidebar,workspace,drawer,modals}.ts`，实现左栏多项目切换、目录浏览初始化弹窗与算力路由配置中心。
  - 实测 `tests/web/e2e_browser.test.ts`：真实 Chromium 验证双项目添加/隔离切换、路由预设切换与自定义模型保存，375px 窄屏零横向溢出且 0 page errors。

---

### [x] WB-12 三栏式 Web UI 重构（下）：协同研讨批注、模型选择器与实时终端 (`src/web/`)

- **前置依赖**：WB-10, WB-11。
- **设计映射**：[DESIGN.md](DESIGN.md) §2.4, §2.5, §3.1, §3.2(2)(3), §4。
- **交付物**：
  - 实现需求工作区 **可视化阶段步进条（Stepper）** 与 **智能行动横幅**：主 CTA 旁内嵌当前阶段默认匹配的 **`[执行器: Harness · Model ▾]`** 下拉选择器，支持执行前一键临时切换其他订阅模型。
  - 实现 **方案共创与 PR 式批注体验**：支持在 `spec.md`、`design.md` 与 `criteria` 上悬停添加 **`[💬 批注 / 提问]`** 内联批注；支持人类直接在线编辑 `design.md`；Agent 修订提交后自动展开 **`v(N-1) → vN` 行级版本 Diff**；并在「规范与方案」页签展示 **跨模型 Code Review 审查卡片**。
  - 实现可折叠 **右栏双视图协同舱（`💬 方案研讨与批注` + `>_ 实时执行终端`）**：支持发问探讨（`Ask`，附 `[采纳此回复并更新方案]`）与批量批注让 Agent 修订（`Refine`）、实时流式输出与 `[查看 handoff.md 交接简报]`、`[终止任务]`、`[使用备援模型接力重试]`；补充完整单元测试与真实 Chromium E2E 回归测试并更新 [README.md](../README.md)。
- **验收标准**：
  - 全量 `bun test`（含多项目切换、模型路由、上下文交接、Ask/Refine 协同闭环与三栏 Web UI 真实 Chromium 端到端闭环）、`bun run typecheck` 与全部文档链路校验 100% 通过。
- **执行记录（WB-12 已完成，2026-11-16）**：
  - 实现工作区 Stage Stepper、行动横幅内联模型选择器与审查触发器、段落悬停批注、直接 `design.md` 编辑、右侧可折叠协同研讨与实时终端抽屉，并更新 [package.json](../package.json)（`5.0.0`）、[README.md](../README.md) 与 [CHANGELOG.md](../CHANGELOG.md)。
  - 实测全量 `bun test`（7 个测试文件，30 pass，0 fail，264 expects，含真实 Chromium E2E 与真实 stdio MCP 子进程）、`bun run typecheck`（`tsc --noEmit` 0 errors）与全部 Markdown 文档链路校验（0 broken links）均 100% 通过。

---

## Phase 3：全流程优化实施清单（FLOW v2：WB-13 – WB-24）

> 按 [FLOW.md](FLOW.md) §5 的 ROI 与依赖顺序拆分为三批：Flow Phase 1（`WB-13`–`WB-16`，基础设施止血 & 省 Token）、Flow Phase 2（`WB-17`–`WB-20`，人机交互与端到端收口）、Flow Phase 3（`WB-21`–`WB-24`，Bug 专属闭环、按需方案评审与长期复利）。

### Flow Phase 1：基础设施止血 & 立刻省 Token

### [x] WB-13 Worktree 默认隔离、环境引导、目录读写锁与 WIP 检查点 (`src/core/worktree.ts`, `src/core/git.ts`, `src/core/runner.ts`, `src/hub/executor.ts`)

- **前置依赖**：WB-12。
- **设计映射**：[FLOW.md](FLOW.md) §2.1, §2.2, §2.5。
- **交付物**：
  - **Worktree 默认隔离与开写对齐**：Git 项目进入 `coding`（`approve` / `fast_track` / `bug`）默认自动创建独立 worktree 沙箱（非 Git 或显式关闭时回退主工作区）；首次 `implement` 启动前若沙箱干净且无相对 `baseHead` 提交，自动快进同步最新主干。
  - **沙箱环境引导与安全校验**：支持 `.worktreeinclude` / 项目配置 `copyFiles` 自动复制本地配置文件，并强制校验目标文件处于 Git 忽略状态（或写入沙箱局部 `info/exclude`）防密钥误提交；支持项目级 `setupScript` 在建沙箱后自动执行一次，失败时停下报错并提供「重试脚本 / 忽略并继续」。
  - **按 `codeRoot` 标准读写互斥锁**：允许多只读任务（`ask` / `review`）同目录并发；写任务（`implement` / `fix`）、验证执行与 WIP 提交独占该 `codeRoot`；`design` 仅改 `.workbench/`，保持单需求互斥、不抢业务代码目录写锁。
  - **自动 WIP 检查点与内容树快照指纹**：沙箱内每轮 `implement` / `fix` 只要产生代码改动（含限流、超时、手动停止中断的半成品改动）均自动提交 WIP（排除 `.workbench/` 与 `.omp/workbench/`）；关闭 worktree 时自动跳过 WIP 并降级常规 Diff。将验证有效性与 `verify-cache` 快照匹配改为基于**代码文件内容树（Tree 指纹，剥离 `HEAD` commit hash）**，确保自动 WIP 不导致轮内已跑验证过期或缓存失效。
- **验收标准**：
  - 真实临时 Git 仓库集成测试通过：进入 `coding` 自动建沙箱、`.worktreeinclude` 仅复制已忽略配置且不被 WIP 提交、`setupScript` 失败可阻断与重试、读写锁阻断双写与读写冲突并放行双读、中断/正常退出均自动打 WIP、WIP 提交后轮内 `wb verify` 证据与 `verify-cache` 仍 100% 命中。
- **执行记录（WB-13 已完成，2026-11-26）**：
  - 新增 `src/core/code_lock.ts`（标准目录读写锁与子租约重入），升级 `src/core/git.ts`（纯内容树 `computeWorkingTreeContentTreeOid` 指纹）、`src/core/worktree.ts`（`.worktreeinclude` / `copyFiles` 忽略校验、`setupScript` 执行与 `retryOrIgnoreSandboxSetup`、`commitSandboxWipCheckpoint`、`syncCleanSandboxBeforeFirstImplement`）、`src/core/runner.ts`、`src/core/sandbox.ts`、`src/core/engine.ts`、`src/server/project_api.ts`（`approve` / `fast-track` 默认沙箱隔离及 `POST /sandbox/setup`）。
  - 实测 `tests/hub/flow_phase1.test.ts`、`tests/core/git_runner.test.ts`、`tests/server/server_bridge.test.ts` 与 `tests/web/e2e_browser.test.ts` 全部通过。

---

### [x] WB-14 审查 `block` 自动闭环（封顶 1 轮）与过期 `block` 硬防线 (`src/core/validity.ts`, `src/core/engine.ts`, `src/hub/executor.ts`, `src/hub/post_run.ts`)

- **前置依赖**：WB-13。
- **设计映射**：[FLOW.md](FLOW.md) §3.2, §1.2。
- **交付物**：
  - **触发时机收口**：`plan_first`（及后续 `bug`）在全部自动化验证命令通过后即默认触发异构审查，不等待 `manual` 人工检查项勾选；常规 `fast_track` 默认不自动审（保留人工一键触发）。
  - **有封顶的 `block` 自动闭环**：初审返回 `block` → 自动把 findings（附最小复现与预期行为）交同档主程跑 1 次 `fix` → 自动验证 → 验证通过后自动跑 1 次复审；若该次 `fix` 导致验证失败，最多再自动抢救 1 次测试失败；抢救仍失败或复审仍未 `pass` 立刻停下亮红点交人。`concern` 不自动触发 `fix`。
  - **过期 `block` 强制 `overrideReason`**：引擎层 `acceptRequirement` 补齐防线——上一份审查为 `block` 且因改代码变为 `stale` 时，跳过复审直接验收必须填写 `overrideReason`（与 `current block` 一致）。
- **验收标准**：
  - 模拟调度与引擎单元测试通过：覆盖 `block → fix → verify → re-review` 全闭环、`block-fix` 改挂测试最多抢救 1 次后熔断、`concern` 不自动修、`stale block` 无 `overrideReason` 验收返回 409/门禁失败。
- **执行记录（WB-14 已完成，2026-11-26）**：
  - 更新 `src/hub/post_run.ts`、`src/hub/executor.ts`、`src/hub/prompt.ts`、`src/core/engine.ts` 与 `src/core/validity.ts`：落地自动化命令全绿即触发审查、封顶 1 轮 `block -> auto_review_fix -> verify(max 1 rescue) -> auto_re_review -> stop` 闭环及 `stale block` 强制 `overrideReason` 引擎门禁。
  - 实测 `tests/hub/flow_phase1.test.ts` 与 `tests/hub/review_workflow.test.ts` 全部通过。

---

### [x] WB-15 增量复审（`lastReviewCommit..HEAD`）与同模型原生续接 (`src/core/types.ts`, `src/hub/handoff.ts`, `src/hub/executor.ts`, `src/hub/harness_cmd.ts`, `src/web/`)

- **前置依赖**：WB-13, WB-14。
- **设计映射**：[FLOW.md](FLOW.md) §2.2, §3.2。
- **交付物**：
  - 审查记录保存锚点提交（`reviewedCommit`）与审查会话元数据；复审交接包精准注入「上轮 findings 清单 + 增量 Diff（`lastReviewCommit..HEAD`）」。
  - 当自动复审由同一 `reviewer` harness 且同一模型执行、上轮上下文处于健康区间、且 `lastReviewCommit` 仍为当前 `HEAD` 祖先（未发生主干同步/变基）时，启用原生会话续接；任一条件不满足（含关闭 worktree、切换备援模型、主干同步/变基）自动降级为「全量 Diff（`baselineHead..HEAD`）+ `fresh_handoff`」。
  - 后端 API 与前端审查卡片新增**「独立重审」**逃生舱（强制 `fresh_handoff`）。
- **验收标准**：
  - 单元测试与 Mock CLI 集成测试覆盖：同模型健康续接 + 精确增量 Diff、主干同步/换模型自动降级全量 + 新会话、手动点击「独立重审」强制全新会话。
- **执行记录（WB-15 已完成，2026-11-26）**：
  - 扩展 `ReviewReport`（`reviewedCommit` / `reviewerSessionId`），在 `src/core/git.ts` 导出 `isAncestorCommit` / `hasMergeCommitsBetween` / `observeIncrementalDiff`，在 `src/hub/handoff.ts`、`src/hub/prompt.ts`、`src/hub/executor.ts` 落地增量 Diff 注入、同模型原生续接与自动降级，并在 `src/server/project_api.ts`、`src/web/{api,queries,i18n}.ts` 与 `src/web/components/WorkspaceView.tsx` 接入「独立重审」（`forceFreshSession`）。
  - 实测 `tests/hub/flow_phase1.test.ts` 与 `tests/web/i18n.test.ts` 全部通过。

---

### [x] WB-16 Prompt 缓存友好排序、编码容错与环境失败分流 (`src/hub/prompt.ts`, `src/hub/handoff.ts`, `src/hub/executor.ts`, `src/hub/post_run.ts`)

- **前置依赖**：WB-13。
- **设计映射**：[FLOW.md](FLOW.md) §1.6, §2.3, §2.4, §3.1。
- **交付物**：
  - **Prompt 缓存友好排序**：重构 `prompt.ts` / `handoff.ts` 拼装顺序，稳定指令/规范/方案前置，动态反馈/失败日志/未决批注后置；对自动读取仓库指令的 CLI 避免重复注入 `AGENTS.md`。
  - **Anti-Loop 破局**：同一失败原因触发自动自愈时，第 1 次 `fix` 续接原会话，第 2 次 `fix` 强制开新会话（`fresh_handoff`）。
  - **429 中途限流接力**：取消自动备援接力的 `durationMs < 60_000` 限制，编码任意时长触发 429 均基于最新 WIP 检查点/diff 单跳切同档备援。
  - **零改动硬保护**：`implement` 正常退出但相对 baseline 内容树 0 改动时，禁止标为就绪待验收，提示「未产出代码改动」交人核查（并支持人工确认无需改动后直接关闭，避免死锁）。
  - **失败快速分流与空闲超时评估**：`exit 127`（命令不存在）或 `timedOut`（验证超时）等环境故障直接提示交人，不派模型盲修；补充历史运行日志回放脚本，统计空闲超时误杀率、挂起检出耗时与样本缺口。
- **验收标准**：
  - 单元测试验证 Prompt 静态前缀稳定性、第 2 次 `fix` 强制 `fresh_handoff`、长耗时 429 自动单跳备援、0 改动拦截与人工关闭出口、`exit 127`/`timedOut` 跳过自动自愈。
- **执行记录（WB-16 已完成，2026-11-26）**：
  - 更新 `src/hub/handoff.ts`、`src/hub/prompt.ts`、`src/hub/executor.ts`、`src/hub/post_run.ts`、`src/core/validity.ts` 并新增 `scripts/replay-idle-timeout.ts`。
  - 回放本仓库 150 条历史运行（54 条含可评估事件、96 条日志不足以判断）：180s 误停 11 次成功运行、300s 误停 2 次、600s/900s 误停 0 次，验证当前 900s 编码空闲超时默认值无误停风险。
  - 实测全量 `bun run typecheck`（0 errors）、核心/Hub/服务端测试与真实 Chromium E2E（含 `tests/hub/flow_phase1.test.ts`、`tests/web/e2e_browser.test.ts`、`tests/web/delivery_browser.test.ts`）全部通过。

---

### Flow Phase 2：人机交互与端到端流转收口

### [x] WB-17 方案阶段 Prompt 内联、单次提交与无关全局配置隔离 (`src/hub/prompt.ts`, `src/hub/handoff.ts`, `src/hub/harness_cmd.ts`, `src/hub/post_run.ts`)

- **前置依赖**：WB-16。
- **设计映射**：[FLOW.md](FLOW.md) §1.6。
- **交付物**：
  - `design` Prompt 直接内联 `spec.md` 全文、`lastFeedback`、未解决批注与结构化提交示例（含内联验收条件与可选待拍板决策块格式），消除 `wb --help` / 反复回读开销。
  - 在各 Harness CLI 能力允许时通过参数/环境变量隔离无关用户全局 skills / hooks 噪音（按 harness 显式适配并记录支持矩阵）。
- **验收标准**：
  - Prompt 快照测试与命令构造单元测试通过，确认 `design` 首轮无需摸索 CLI 即可直接落盘并同步提案，各支持 harness 的隔离参数正确注入且不影响正常读写工具。
- **执行记录（WB-17 已完成，2026-11-26）**：
  - 更新 `src/hub/harness_cmd.ts`、`src/hub/prompt.ts`、`src/hub/post_run.ts`、`src/hub/executor.ts`：新增并导出 `HARNESS_ISOLATION_MATRIX` 与 `buildHarnessIsolationEnv`（`omp: --no-skills --no-extensions`、`agy: --disable-slash-commands`、`qodercn: --setting-sources project,local`、`opencode: OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`、`codex: supported=false` 显式登记）；`design` Prompt 直接内联 `spec.md` 全文、`originalGoal`、反馈/批注及 `workbench-criteria`（含 `manual`）/`workbench-decisions` 格式示例并免除 `wb --help`/`wb get`。
  - 实测 `tests/hub/flow_phase2.test.ts`、`tests/hub/hub.test.ts` 与 `tests/hub/run_guards.test.ts` 全部通过。

---

### [x] WB-18 `manual` 验收条件、置顶 `originalGoal` 与决策卡片双出口 (`src/core/`, `src/hub/post_run.ts`, `src/server/`, `src/web/`)

- **前置依赖**：WB-17。
- **设计映射**：[FLOW.md](FLOW.md) §1.1, §1.2, §1.4。
- **交付物**：
  - **只读 `originalGoal`**：创建需求时持久化不可变 `originalGoal`，审批页原样置顶展示在 `spec.md` 上方（不做满屏字符级 diff）。
  - **`manual` 验收条件闭环**：扩展 `Criterion` 支持 `manual` 类型及人工检查步骤；验收页支持人类逐条勾选「已核验」并绑定当前 `specHash + codeSnapshotHash`（代码/规范改动后自动过期需重勾）；硬不变量 ③（至少 1 条验收条件）守在「批准进入 coding / 最终验收」关口，首轮方案附带未决决策卡片时允许暂缓补齐。
  - **内嵌决策卡片（非 Modal）与双出口**：支持从方案同步结构化待拍板卡片（每题含问题描述 + 2–4 选项含推荐项 + 自定义输入），状态持久化并计入左栏待拍板红点；「采纳选择并直接批准进入编码」仅在全选预设选项且已有验收条件时启用，原子绑定规范/方案/条件/已采纳决策并共享给编码、修复与审查（以人类决策为权威）；存在未作答项、手写自定义答案或尚无验收条件时禁用直接批准，改走「提交决策并修订方案」一次性打包卡片答案与全部未解决行内批注。
- **验收标准**：
  - 核心引擎测试 + 真实浏览器 E2E 通过：覆盖 `originalGoal` 置顶、`manual` 项勾选与改代码后自动过期、决策卡片直接批准与禁用拦截条件、打包卡片 + 批注一轮修订，以及已采纳决策注入编码/修复/审查上下文。
- **执行记录（WB-18 已完成，2026-11-26）**：
  - 更新 `src/core/types.ts`、`src/core/validate.ts`、`src/core/validity.ts`、`src/core/engine.ts`、`src/hub/post_run.ts`、`src/hub/handoff.ts`、`src/server/project_api.ts` 及 `src/web/`：实现不可变 `originalGoal` 置顶展示、`manual` 验收条件及 `specHash + codeSnapshotHash` 绑定人工核验/改代码自动过期、批准关口硬不变量 ③ 守卫、非 Modal 内嵌决策卡片（异步持久化 `PATCH /decisions` + 双出口直批/打包修订 `POST /decisions/revise`），以及 `humanDecisions`（绑定 `decisionsHash`）作为权威裁决注入编码/修复/审查上下文。
  - 实测 `tests/hub/flow_phase2.test.ts` 与真实 Chromium E2E `tests/web/flow_phase2_browser.test.ts`、`tests/web/i18n.test.ts` 全部通过（0 控制台/页面报错）。

---

### [x] WB-19 `revisePlan` 人工回退流转与自愈耗尽 `needs_human` 升级 (`src/core/engine.ts`, `src/core/worktree.ts`, `src/core/validity.ts`, `src/server/`, `src/web/`)

- **前置依赖**：WB-13, WB-16。
- **设计映射**：[FLOW.md](FLOW.md) §1.5, §3.1。
- **交付物**：
  - **`revisePlan` 领域动作与人工主权**：严禁 Agent 直接回退阶段（Agent 仅暂停上报并亮红点）；人类触发 `revisePlan` 时执行 `coding → planning`、作废 `approval`、将当前 `git diff` 写入 `handoff.md` 并保持沙箱工作区不动。
  - **重新进入编码的沙箱重置选项**：退回修订并重新批准进入 `coding` 时，默认保留沙箱现有改动，同时提供可选勾选「清空旧改动从干净基线重新开始」（重置沙箱至 `baseHead`）。
  - **自愈/闭环耗尽 `needs_human`**：自愈或 `block` 闭环达到上限仍失败时，明确派生 `needs_human` 状态并计入左栏红点，Banner 直达「升级 SOTA 主程接管」与「退回修改方案（`revisePlan`）」。
- **验收标准**：
  - 单元测试与 API/UI 集成测试通过：覆盖 `revisePlan` 状态流转与 diff 入 handoff、重新批准保留 vs 清空旧改动两种路径、自愈耗尽触发红点与一键升 SOTA/退回方案。
- **执行记录（WB-19 已完成，2026-11-26）**：
  - 更新 `src/core/engine.ts`、`src/core/worktree.ts`、`src/core/validity.ts`、`src/hub/executor.ts`、`src/server/project_api.ts` 及 `src/web/`：实现仅面向人类的 `revisePlan`（未暴露给 Agent CLI/MCP，执行 `coding → planning`、作废 `approval`、将沙箱 `git diff` 快照写入 `handoff.md` 并保持沙箱不动）、重新批准时默认保留 vs 可选 `resetSandbox` 重置至 `baseHead`（保留 gitignored `.env`），以及自动自愈/审查修复闭环耗尽派生 `needsHuman` 危险横幅与一键 `escalate_sota` / `revise_plan`。
  - 实测 `tests/hub/flow_phase2.test.ts` 与 `tests/web/flow_phase2_browser.test.ts` 全部通过。

---

### [x] WB-20 默认沙箱一键交付双出口（自动 squash）与多沙箱联动 (`src/core/engine.ts`, `src/core/worktree.ts`, `src/core/git.ts`, `src/server/`, `src/web/`)

- **前置依赖**：WB-13。
- **设计映射**：[FLOW.md](FLOW.md) §4.2, §4.3。
- **交付物**：
  - **交付前基线与文件树核对**：校验目标基线与实际交付文件树（Tree OID）；仅改写提交历史且基线与文件树均与验收一致时复用验收结论；选文件、变更基线或解冲突导致内容/范围变化时要求重新验证受影响条件并由人确认。
  - **一键交付双出口与零 Token 预填**：由 `spec` 与变更摘要零额外 LLM Token 预填 commit message 与 PR 标题/正文；沙箱内 WIP 检查点交付时自动 squash 为干净提交，支持「提交并创建 PR（GitHub / Gitee）」与「一键合入本地主干（遇冲突衔接现有冲突消解流）」。
  - **安全清理与多沙箱联动**：确认交付成果落地后再清理沙箱；取消需求时若存在未交付独有提交或本地改动，保留 worktree 与分支供恢复或显式丢弃；需求合入主干后自动快进同项目无改动的干净沙箱，并对已有改动的活跃沙箱展示温和漂移提示。
- **验收标准**：
  - 真实多 worktree Git 仓库集成测试通过：覆盖多 WIP 自动 squash 合入本地主干、PR 创建与合并后清理、文件树变化阻断直接复用验收、取消含未交付改动保留沙箱、合入后干净兄弟沙箱自动快进与脏沙箱漂移提示。
- **执行记录（WB-20 已完成，2026-11-26）**：
  - 更新 `src/core/git.ts`、`src/core/worktree.ts`、`src/core/engine.ts`、`src/server/project_api.ts` 及 `src/web/`：新增 `computeSelectedFilesContentTreeFingerprint`、`countWipCommitsBetween`、`squashBranchCommitsToSingleCommit`、`mergeSandboxToMain`、`cleanupSandboxOnCancel`、`discardSandboxWorktree` 与 `cleanOnly` 级联快进；实现零额外 Token 提交信息/PR 预填、交付前 Tree OID 核对、WIP 自动 squash 一键合入本地主干/PR 交付、主干落地确认后清理、取消保留未交付沙箱及显式丢弃出口、以及合入后干净兄弟沙箱快进与脏沙箱 `drifted` 温和提示。
  - 实测全量 `bun run typecheck`（0 errors）、全仓库 64 个测试文件（含 `tests/hub/flow_phase2.test.ts`、`tests/web/flow_phase2_browser.test.ts`、`tests/core/delivery.test.ts`、`tests/web/delivery_browser.test.ts`、`tests/web/icons_bundle.test.ts`）全部通过。

---

### Flow Phase 3：Bug 专属闭环、按需方案评审与长期复利

### [x] WB-21 `kind: feature | bug` 分流与 Bug 单段修复闭环 (`src/core/`, `src/hub/executor.ts`, `src/hub/prompt.ts`, `src/server/`, `src/web/`)

- **前置依赖**：WB-14, WB-19。
- **设计映射**：[FLOW.md](FLOW.md) §1B, §3.2。
- **交付物**：
  - **需求类型 `kind`**：扩展领域模型新增 `kind: "feature" | "bug"`（存量默认 `feature`）；创建/导入 Bug 仅登记条目，人类点击「开始修复」（或「创建并开始修复」）沿用 `fast_track` 授权直接进入 `coding`，在同一会话内完成复现、定位、回归测试与修复。
  - **Bug 回归测试只增不删 & 默认异构审查**：允许 `kind: "bug"` 在 `coding` 期「只增不删」追加回归测试验收条件（不作废启动授权、严禁删除或削弱已有条件）；自动审查按 `plan_first` 与 `bug` 开启，与常规 `fast_track` 清晰解耦。
  - **暂停上报与升级转正**：Bug 无法复现或涉及公共契约/架构变更时主动暂停上报并亮红点，支持人工「补充信息继续修」或「转常规方案流程」（保留 `kind: "bug"` 标签，轨道切为 `plan_first`）。
- **验收标准**：
  - 端到端集成测试通过：覆盖 Bug 创建 → 授权开始修复 → 追加回归测试条件并跑绿（不作废授权）→ 自动触发异构审查 → 验收闭环，以及暂停上报后补充信息继续与转 `plan_first`（保留 `kind: "bug"`）。
- **执行记录（WB-21 已完成，2026-11-26）**：
  - 更新 `src/core/types.ts`、`src/core/validate.ts`、`src/core/validity.ts`、`src/core/engine.ts`、`src/hub/prompt.ts`、`src/hub/executor.ts`、`src/server/project_api.ts` 及 `src/web/`：新增 `kind: "feature" | "bug"`（存量默认 `feature`）、创建弹窗「仅登记 Bug / 创建并开始修复」、`appendBugRegressionCriteria` 与编码期严格只增不删守卫（`isStrictAppendOnlyCriteriaUpdate`）、`plan_first`/`bug` 自动异构代码审查解耦、`workbench-pause` 主动暂停上报（`needsHuman.source === "bug_pause"`，严禁 Agent 擅自改阶段），以及保留 `kind: "bug"` 标签转常规方案流程（`revisePlan` 切 `track: "plan_first"`）。
  - 实测 `tests/hub/flow_phase3.test.ts` 与真实 Chromium E2E `tests/web/flow_phase3_browser.test.ts` 全部通过。

---

### [x] WB-22 按需异构方案评审（独立存储与非阻断审批） (`src/core/`, `src/hub/executor.ts`, `src/hub/prompt.ts`, `src/server/`, `src/web/`)

- **前置依赖**：WB-18。
- **设计映射**：[FLOW.md](FLOW.md) §1.3。
- **交付物**：
  - `sota` 档位在方案提交后默认自动触发异构方案评审，常规 `plan_first` 在审批页提供一键「异构评审方案」。
  - 新增独立字段 `designReviewReport`（绑定 `specHash + designHash`，完全隔离于编码后的代码审查 `reviewReport`，避免误触发过期代码审查 `block` 防线）。
  - 方案评审返回 `block` 时审批页醒目展示并提供一键「按评审意见修订方案」，不自动重跑、不强制填写 `overrideReason`、不阻断人类直接批准。
- **验收标准**：
  - 单元测试与 UI 集成测试通过：验证 `sota` 默认触发、常规需求按需触发、`designReviewReport` 随方案修改自动标 `stale`、返回 `block` 可一键打包修订也可直接批准且进入 `coding` 后不污染代码审查状态。
- **执行记录（WB-22 已完成，2026-11-26）**：
  - 更新 `src/core/types.ts`、`src/core/validate.ts`、`src/core/validity.ts`、`src/core/engine.ts`、`src/hub/prompt.ts`、`src/hub/executor.ts`、`src/server/project_api.ts` 及 `src/web/`：新增独立 `designReviewReport` 与 `evaluateDesignReviewReport`（严格绑定 `specHash + designHash`，`sota` 方案提交后自动触发一次异构评审，常规需求提供 `POST /design-review` 与审批页一键触发）；返回 `block` 时展示可一键修订卡片，不自动重跑、不阻断直接批准、且绝不污染编码后 `reviewReport` 门禁。
  - 实测 `tests/hub/flow_phase3.test.ts`、`tests/hub/run_guards.test.ts` 与 `tests/web/flow_phase3_browser.test.ts` 全部通过。

---

### [x] WB-23 `fast_track` 诚实标示与验收页 4 要素收口 (`src/core/validity.ts`, `src/web/`)

- **前置依赖**：WB-18, WB-20, WB-21。
- **设计映射**：[FLOW.md](FLOW.md) §2.5, §4.1。
- **交付物**：
  - **`fast_track` 诚实信号**：引擎识别仅由系统自动注入通用基线命令、无本需求专属测试的需求，在验收页显式提示「仅通过项目基线检查，无专属测试，请重点核对 Diff」。
  - **验收页 4 要素一屏收口**：收拢展示① 可信度摘要（验证覆盖率、基线诚实标示、异构审查结论）；② 代码 Diff 与测试篡改告警；③ UI 截图对比（涉及 UI 时）；④ 出口按钮（「验收通过（可选顺手打开一键交付）」/「打回修改」/「推翻方案 `revisePlan`」）。
- **验收标准**：
  - 真实浏览器 E2E 回归验证通过：覆盖 `fast_track` 诚实告警显隐、验收页 4 块信息布局完整、无多余噪音与 0 console/page errors。
- **执行记录（WB-23 已完成，2026-11-26）**：
  - 更新 `src/core/types.ts`、`src/core/engine.ts`、`src/core/validity.ts`、`src/hub/post_run.ts` 与 `src/web/`：为系统自动注入的通用基线条件标注 `systemInjected: true`，新增 `isFastTrackBaselineOnly` 派生 `validity.baselineOnlyWarning`；在工作区滚动区顶部新增 `AcceptanceSummaryPanel` 一屏收口 4 要素（非 UI 需求隐藏截图块零噪音，支持「验收后顺手打开一键交付」）。
  - 实测真实 Chromium E2E `tests/web/flow_phase3_browser.test.ts`、`tests/web/e2e_browser.test.ts`、`tests/web/e2e_i18n_layout_browser.test.ts` 全部通过（0 console/page errors）。

---

### [x] WB-24 轻量经验沉淀（`playbook.md`）、文档对齐与调优验证 (`src/core/engine.ts`, `src/hub/ledger.ts`, `src/web/`, `docs/`)

- **前置依赖**：WB-20, WB-21, WB-22, WB-23。
- **设计映射**：[FLOW.md](FLOW.md) §4.4, §5。
- **交付物**：
  - **轻量经验沉淀**：在人类打回修改、验收备注与解决重要审查 `block` 交互处提供轻量勾选框「记住这条项目经验」，统一追加精炼条目至 `.workbench/playbook.md`（零额外同步按钮/步骤、不碰业务代码与 Git、不触发重测、后续调度立刻生效）。
  - **文档一致性收口**：清理 [DESIGN.md](DESIGN.md) 中的旧路由矩阵漂移，并同步更新 [DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md) 新增字段与领域不变量（`kind`、`originalGoal`、`manual` 条件、决策记录、`designReviewReport`、树指纹快照、WIP/交付核对）。
  - **调优验证与遥测报表**：基于 `runs-ledger.jsonl` 与项目状态，按轨道（`plan_first` / `fast_track` / `bug`）与 harness 输出每个已验收需求的模型调用次数、可观测 Token（缺失记为未知）、验收耗时、验收后重开率以及取消/未完成数，用于校准后续自动预算与续接阈值。
- **验收标准**：
  - 勾选经验沉淀单元测试与 UI 测试通过（验证不修改主仓库/沙箱源码与快照指纹）；调优统计脚本输出完整字段且缺失遥测显式记为未知；全量 `bun test`、`bun run typecheck` 与全部文档链接检查 100% 通过。
- **执行记录（WB-24 已完成，2026-11-26）**：
  - 更新 `src/core/engine.ts`、`src/hub/handoff.ts`、`src/hub/ledger.ts`、`src/server/project_api.ts`、`src/web/`，新增 `scripts/tuning-report.ts`，并同步收口 `docs/DESIGN.md` 与 `docs/DOMAIN_CONTRACT.md`：实现 `.workbench/playbook.md` 原子去重追加（16KB 上限、不污染源码与 Git 快照、后续非审查交接简报即时生效）、打回/验收/审查 `block` 一键记住交互、以及按轨道（`plan_first` / `fast_track` / `bug`）和 Harness 的调优遥测报表（实测对本仓库输出 23 条需求、39 已知 / 111 未知 Token 遥测统计）。
  - 实测 `bun run typecheck`（0 errors）、全仓库 66 个测试文件（含 `tests/hub/flow_phase3.test.ts`、`tests/web/flow_phase3_browser.test.ts`、`tests/web/i18n.test.ts`、`tests/web/icons.test.tsx`、`tests/web/icons_bundle.test.ts`、`tests/web/e2e_browser.test.ts`、`tests/web/e2e_i18n_layout_browser.test.ts`）与 `docs/*.md` 全量相对链接校验 100% 通过。
