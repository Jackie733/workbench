# 新一代工作台实施任务清单（WB-01 – WB-07）

> 唯一实施进度入口。设计规范见 [DESIGN.md](DESIGN.md)，领域与存储契约见 [DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md)。旧版 Tern-Luau 单体架构及 `AF-01–AF-16` 任务记录已归档至 [archive/2026-11-16/TASKS.md](archive/2026-11-16/TASKS.md)，不继承旧版未完成的包袱。

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
