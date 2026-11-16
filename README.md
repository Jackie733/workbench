# Workbench — 常驻多项目中心与多模型路由工作台（v5.0）

本地优先、常驻运行、Agent 无关的 **Spec & Verification Workbench Hub**（基于 **Lightweight SDD + VDD**）。帮助开发者在同一个常驻三栏 Web 指挥舱内统筹**多个本地 Git 项目**与**多份 AI 订阅算力（ChatGPT Plus / Google AI Pro / QoderCN / OpenCode Go / omp）**——由人类守住方案审批与真实验证验收两头关口，中间调度最合适的模型接力执行、探讨与交叉审查。

仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。本机源码：`/home/jackie/code/workbench`。

---

## 核心特性（v5.0 Hub）

1. **常驻多项目控制中心（`wb start` / `wb open`）**
   - 全局 `wb` CLI（已通过 `bun link` 安装到 `$PATH`）一键后台启动常驻 Hub 守护进程（默认端口 `4318`，数据存放在 `~/.workbench-hub/`）。
   - 三栏式 Web 指挥舱左栏提供**多项目实时切换**、**本机目录浏览器与初始化引导**、以及待拍板数与后台执行状态呼吸灯。
2. **多 Harness 自动探测与分阶段算力路由**
   - 自动探测本机 `codex`、`qodercn`、`opencode`、`gemini`、`omp` 及模型目录，支持自定义追加付费模型（如 OpenCode Go）。
   - 内置 `balanced`（推荐默认）、`sota_first`、`quota_saver` 三套策略预设：优先将稀缺 SOTA 额度投入低 Token、高杠杆的 `design`（规划）与 `review`（跨模型审查），将高频高消耗的 `implement` / `fix` 路由至高吞吐主力或免费模型。
   - **主动后台执行与实时终端**：支持在主操作横幅内联切换执行模型、点击后台拉起 CLI 子进程流式推流日志、随时终止任务，或在触发限流/失败时一键切换备援模型接力重试。
3. **跨 Harness 双层上下文交接与 PR 式共创研讨**
   - **双层交接**：同 Harness 优先 `--resume` 原生会话；跨 Harness 切换或异常中断后，自动合成有界 `handoff.md`（汇总契约、Agent 备忘与死胡同标记、`git diff` 现场与失败日志末尾）。
   - **非流水线共创**：支持对 `spec.md`、`design.md` 与验收条件悬停添加段落级 **`[💬 批注 / 提问]`**、右侧研讨流区分 **`仅提问探讨 (Ask)`**（纯只读不改方案）与 **`按批注修订 (Refine)`**（改完自动弹出 `vN-1 → vN` Diff）、以及人类直接在线编辑 `design.md`。
4. **验证驱动与人工主权边界**
   - 任何 Agent（CLI / MCP / Hub 子进程）均不可伪造 `passed` 状态，也无权替代人类点击 `approve`、`fast_track` 或 `accept`；跨模型审查结论（`pass / concern / block`）与验证证据均绑定当前 `specHash` 与工作区 Git 快照指纹，代码改动后自动标为过期（`stale`）。

---

## 快速上手

### 1. 日常一键使用（推荐）

已在全局安装 `wb` 命令，可在任意 Git 项目或任意目录运行：

```sh
# 确保 Hub 后台常驻运行并自动在浏览器打开工作台
wb open

# 查看或管理后台守护进程
wb status
wb start --port 4318
wb restart
wb stop
```

首次进入 Web 工作台后，可在左侧栏点击 **`+ 添加`** 直接浏览并纳管你的本地 Git 仓库，或在 **`⚙ 路由`** 中调整各订阅模型配比。

### 2. 在 `omp` 中联动或挂载其他 Agent MCP

- **`omp` 会话联动**：本机 `~/.omp/agent/extensions/workbench.ts` 已重导出 [omp/index.ts](omp/index.ts)，会话中输入 `/wb` 即可打开工作台并建立实时指令桥接。
- **其他 MCP 客户端（Claude Code / Codex / Cursor / OpenCode 等）**：

```json
{
  "mcpServers": {
    "workbench": {
      "command": "wb",
      "args": ["mcp"]
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
| [设计规范](docs/DESIGN.md) | v5.0 Hub 产品定位、多 Harness 路由矩阵、双层交接、共创闭环与三栏指挥舱设计 |
| [领域契约](docs/DOMAIN_CONTRACT.md) | `.workbench/` 与 `~/.workbench-hub/` 存储分层、不变量与验证/主权门禁 |
| [实施任务](docs/TASKS.md) | Phase 1（`WB-01`–`WB-07`）与 Phase 2（`WB-08`–`WB-12`）实施进度与实测记录 |
| [历史归档](docs/archive/README.md) | 旧版 Tern-Luau 方案（2026-11-16 归档），仅供追溯 |

---

## 运行与安全边界

- **本地数据策略**：业务数据按项目独立存放在各自仓库 `.workbench/` 下（默认写入 `.git/info/exclude`）；全局项目列表与路由策略存放在 `~/.workbench-hub/`。
- **单向拍板控制**：MCP Server 与 `wb` CLI 不向 Agent 暴露 `approve`、`fast_track` 或 `accept` 接口；零必需验收条件禁止验收通过。
- **可控子进程与诚实边界**：Hub 调度器为外部 CLI 子进程绑定独立进程组（支持一键强杀无残留）；不修改各外部 CLI 全局认证状态，不自动执行 `git commit`、`git push` 或分支合并。
