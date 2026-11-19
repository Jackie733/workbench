[English](README.md) | **简体中文**

# Workbench — 常驻多项目中心与多模型路由工作台（v5.0）

本地优先、常驻运行、Agent 无关的 **Spec & Verification Workbench Hub**（基于 **Lightweight SDD + VDD**）。帮助开发者在同一个常驻三栏 Web 指挥舱内统筹**多个本地 Git 项目**与**多份 AI 订阅算力（ChatGPT Plus / Google AI Pro / QoderCN / OpenCode Go / omp）**——由人类守住方案审批与真实验证验收两头关口，中间调度最合适的模型接力执行、探讨与交叉审查。

`omp` 只是可选的集成适配器之一，不是宿主，也不是必需依赖：任何已安装的 Coding Agent CLI（`codex` / `qodercn` / `opencode` / `agy` / `omp`）都可以被调度。

仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。

---

## 核心特性（v5.0 Hub）

1. **常驻多项目控制中心（`wb start` / `wb open`）**
   - 全局 `wb` CLI 可通过 `bun link` 安装到 `$PATH`；推荐使用用户级服务托管 Hub（默认端口 `4318`，数据存放在 `~/.workbench-hub/`）。
   - 三栏式 Web 指挥舱左栏提供**多项目实时切换**、**本机目录浏览器与初始化引导**、以及待拍板数与后台执行状态呼吸灯。
2. **多 Harness 自动探测与分阶段算力路由**
   - 自动探测本机 `codex`、`qodercn`、`opencode`、`agy`（Antigravity / Gemini CLI）、`omp` 及模型目录，支持自定义追加付费模型（如 OpenCode Go）。
   - 内置 `balanced`（推荐默认）、`sota_first`、`quota_saver` 三套策略预设：优先将稀缺 SOTA 额度投入低 Token、高杠杆的 `design`（规划）与 `review`（跨模型审查），将高频高消耗的 `implement` / `fix` 路由至高吞吐主力或免费模型。
   - **主动后台执行与实时终端**：支持在主操作横幅内联切换执行模型、点击后台拉起 CLI 子进程流式推流日志、随时终止任务，或在触发限流/失败时一键切换备援模型接力重试。
3. **跨 Harness 双层上下文交接与 PR 式共创研讨**
   - **双层交接**：同 Harness 优先复用各 CLI 原生会话续接机制；跨 Harness 切换或异常中断后，自动合成有界 `handoff.md`（汇总契约、Agent 备忘与死胡同标记、`git diff` 现场与失败日志末尾）。
   - **非流水线共创**：支持对 `spec.md`、`design.md` 与验收条件悬停添加段落级 **`[💬 批注 / 提问]`**、右侧研讨流区分 **`仅提问探讨 (Ask)`**（纯只读不改方案）与 **`按批注修订 (Refine)`**（改完自动弹出 `vN-1 → vN` Diff）、以及人类直接在线编辑 `design.md`。
4. **验证驱动与人工主权边界**
   - 任何 Agent（CLI / MCP / Hub 子进程）均不可伪造 `passed` 状态，也无权替代人类点击 `approve`、`fast_track` 或 `accept`；跨模型审查结论（`pass / concern / block`）与验证证据均绑定当前 `specHash` 与工作区 Git 快照指纹，代码改动后自动标为过期（`stale`）。
5. **局域网访问与远程节点**
   - Hub 默认仅监听 `127.0.0.1`；显式以 `wb service install --host 0.0.0.0` 才开启局域网访问，非 loopback 客户端必须通过访问密码登录（浏览器登录或 `Authorization: Bearer <密码>`）。
   - `wb service password` 生成或重置局域网访问密码，同一密码也用于 `wb node install --token`；WSL2 等环境可用 `wb node` 系列命令安装轻量桥接服务，把本机能力接入主控 Hub。
6. **自进化、GitHub 集成与输出语言**
   - **避坑法则（Playbook）**：验收、打回与人类批注会自动沉淀为项目级 `.workbench/playbook.md`，并在交接时注入后续 Agent，避免重复踩坑。
   - **痛点收集箱**：`wb issue "<描述>"` 把工作台自身的缺陷与痛点写入 `~/.workbench-hub/evolution/inbox.jsonl`（指纹去重），可人工转正为需求并在隔离 Git Worktree 沙箱中演进。
   - **GitHub 集成**：`wb github status | import <issueRef> | link-issue <REQ-ID> [issueRef]` 复用本机已登录的 `gh` 会话导入、关联 Issue；`wb config --github-repo <owner/repo>` 用于配置项目仓库，人类验收后可按标准 PR 流程交付。
   - **输出语言**：`wb init --lang zh-CN|en|auto` 与 `wb config --output-language ...` 统一控制规范、方案、审查报告与交接包的语言（项目级覆盖全局默认）。

---

## 快速上手

### 1. 用户级服务部署（推荐）

准备 Git、当前稳定版 Bun 和固定位置的源码，在源码根执行：

```sh
bun run deploy --port 4318
wb service status
# 新项目按需初始化；已有项目无需重建
wb --root /absolute/path/to/project init
bun run deploy:check --url http://127.0.0.1:4318 --root /absolute/path/to/project
wb open
```

macOS 使用 LaunchAgent；Linux/WSL2 使用 systemd 用户服务，WSL2 需要先启用 systemd 和可用用户会话。服务默认仅监听本地 loopback，复用当前用户的 Agent CLI 与认证，不自动修改登录状态。

需要从局域网其他设备访问时，重新安装并显式绑定 `0.0.0.0`，再生成访问密码：

```sh
wb service install --port 4318 --host 0.0.0.0
wb service password
```

非 loopback 客户端必须以该密码登录；密码只以 scrypt 哈希保存在 `<hubDir>/auth.json`（权限 `0600`，目录 `0700`），不写入服务定义与日志。**不要**以绑定 `0.0.0.0` 作为本地访问故障的回退手段。

需要让 WSL2 等环境的目录与命令接入主控 Hub 时，安装远程节点服务（同一访问密码）：

```sh
wb node install --hub http://192.168.1.10:4318 --token <访问密码>
wb node status
```

远程节点服务与主控 Hub 服务彼此独立：`wb service stop/uninstall` 不会停止或卸载节点，反之亦然。

完整的安装、启停、更新、日志、备份、卸载与 Windows MCP 配置见 [部署指南](docs/DEPLOYMENT.md)。`wb start/open/stop/restart` 在安装后由服务管理器执行；`wb status` 同时报告管理器与 Hub 健康状态。

未安装服务时仍可用 `wb start` / `wb open` 启动原有未托管后台 Hub，或主动选择前台运行（不要与同一 Hub 的托管服务同时启动）：

```sh
bun run src/cli/index.ts serve --hub --host 127.0.0.1 --port 4318 --root "$HOME"
```

首次进入 Web 工作台后，可在左侧栏点击 **`+ 添加`** 直接浏览并纳管你的本地 Git 仓库，或在 **`⚙ 路由`** 中调整各订阅模型配比。

### 2. 可选集成：在 `omp` 中联动或挂载其他 Agent MCP

- **`omp` 会话联动（可选）**：可将 [omp/index.ts](omp/index.ts) 配置为 omp 扩展，加载后输入 `/wb` 打开工作台并建立实时指令桥接；项目级服务器生命周期独立于全局 Hub 服务。不安装 `omp` 不影响工作台使用。
- **其他 MCP 客户端（Claude Code / Codex / Cursor / OpenCode 等）**：MCP 是客户端启动的独立 stdio 子进程，不存在 `/mcp` 网络入口。使用真实绝对路径和已初始化的项目：

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

### 3. 本地开发测试与类型检查

```sh
bun install
bun test
bun run typecheck
```

---

## 权威文档

| 文档 | 用途 |
| :--- | :--- |
| [English README](README.md) | 英文主文档（本文档的对等英文版） |
| [设计规范](docs/DESIGN.md) | v5.0 Hub 产品定位、多 Harness 路由矩阵、双层交接、共创闭环与三栏指挥舱设计 |
| [部署指南](docs/DEPLOYMENT.md) | macOS/Linux/WSL2 用户级服务、局域网访问与远程节点、真实 HTTP/WS/MCP 检查、Windows 客户端与恢复边界 |
| [领域契约](docs/DOMAIN_CONTRACT.md) | `.workbench/` 与 `~/.workbench-hub/` 存储分层、不变量与验证/主权门禁 |
| [实施任务](docs/TASKS.md) | Phase 1（`WB-01`–`WB-07`）与 Phase 2（`WB-08`–`WB-12`）实施进度与实测记录 |
| [历史归档](docs/archive/README.md) | 旧版 Tern-Luau 方案（2026-11-16 归档），仅供追溯 |

---

## 运行与安全边界

- **本地数据策略**：业务数据按项目独立存放在各自仓库 `.workbench/` 下（默认写入 `.git/info/exclude`）；全局项目列表与路由策略存放在 `~/.workbench-hub/`。
- **访问边界**：默认仅监听 loopback；显式开启局域网访问时以访问密码保护（`scrypt` 哈希落盘，权限 `0600`），凭据不进入服务定义与日志。
- **单向拍板控制**：MCP Server 与 `wb` CLI 不向 Agent 暴露 `approve`、`fast_track`、`accept` 或 PR 推送接口；零必需验收条件禁止验收通过。
- **可控子进程与诚实边界**：Hub 调度器为外部 CLI 子进程绑定独立进程组（支持一键强杀无残留）；不修改各外部 CLI 全局认证状态，仅在人类验收完成并显式确认后执行受控的 `git commit`、`git push` 与 `gh` Issue/PR 同步。
