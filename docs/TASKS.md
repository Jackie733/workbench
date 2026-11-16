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
| **WB-08** | 全局常驻守护进程与多项目注册中心（Phase 2） | WB-07 | `src/hub/registry.ts`, `src/cli/`, `src/server/` |
| **WB-09** | 多 Harness 自动探测与分阶段模型路由矩阵（Phase 2） | WB-08 | `src/hub/discovery.ts`, `src/hub/routing.ts` |
| **WB-10** | 主动式多 Agent 调度执行器与跨模型审查（Phase 2） | WB-09 | `src/hub/executor.ts`, `src/mcp/`, `src/core/` |
| **WB-11** | 三栏式 Web UI 重构（上）：侧边栏、目录浏览与路由中心 | WB-08, WB-09 | `src/web/` |
| **WB-12** | 三栏式 Web UI 重构（下）：模型选择器、审查视图与实时终端 | WB-10, WB-11 | `src/web/`, 全量与 Chromium E2E |

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
