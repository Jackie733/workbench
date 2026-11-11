# Tern 多模型任务工作台

> 2026-11-11 配置回退：当前全局只保留 `@default = openai-codex/gpt-6.1-sol`，不再定义下文的 `@design/@execute`。本插件代码保留，但其新建设计／执行会话流程依赖这些已撤销角色，暂不作为当前入口；请直接运行 `omp`。下文为回退前的 2.0.0 工作流说明。

> 新方向已确认：一个现有 omp＋一个实时需求交付工作台。完整产品设计、生命周期、数据与事件契约、迁移和分阶段验收见 [产品设计与实施计划](DESIGN_AND_IMPLEMENTATION_PLAN.md)。该文档是后续实施依据，尚未实现；下方旧版流程不代表新设计。

本地插件 `multi-model-workbench` 2.0.0，面向 Windows Tern 0.9.14＋WSL Ubuntu＋omp，使用本机已配置的 `wsl.exe` shell。已通过 link 安装。任务导航使用原生 Canvas，输入使用同插件的原生 host block；不新增市场插件、skill、模型 Provider 或后台服务，不修改凭据与 omp 模型配置。

## 开始使用

1. 在本机 WSL **Git 项目**的终端或已有 omp 会话中，打开 Tern 命令面板，搜索 **“打开 / 恢复任务工作台”**。仓库子目录会解析为 Git 根目录。
2. 在左侧导航点击 **“新任务”**，填写需求，选择 **先设计再执行**或**直接执行**，点击“下一步”（Ctrl+Enter）。此时只是准备任务，不发送模型请求。
3. 核对行内确认中的需求和实际会话／角色，点击“开始设计”或“开始执行”。取消则不发送。“更多”菜单可复制完整待发送指令。
4. 设计交付后在“方案”中审阅，点击 **“批准并开始执行”**，再确认本次发送。执行回合结束只进入“待验收”；查看变更、使用原生 `/review` 或自行核实验证报告后，明确标记“验收完成”。

简单修改可直接执行，不必先生成设计。没有“复制聊天回复→保存→重新选择文件”的必经步骤。

### 会话和模型

- 从已有、模型已知的项目会话打开工作台时，新任务会关联来源会话作为第一阶段的会话；确认时显示 Tern 实际报告的模型，不静默切模。
- 未关联的设计／执行角色在你确认后，通过 omp 已有 `@design`／`@execute` 配置新建独立会话。因此可使用 Codex 设计、Qoder 实施；具体映射、项目覆盖、fallback 和费用仍由 omp 管理。
- 不擅自占用项目中其他空闲聊天。需要复用指定会话时，在任务“详情”选择“设计会话…”或“执行会话…”。选择“新建独立会话”只改变关联，下次明确开始时才启动。
- 普通终端或缺少模型元数据的占位会话不会自动关联。已有目标正忙、等待输入、已退出、发生发送错误或模型未知时，拒绝发送并说明原因。
- 打开工作会话使用原生定位，不克隆聊天、不复制凭据。导航不强制跟随每次标签页切换，避免反复重排终端；再次打开会复用本窗口导航。宽度可拖动，并在新建表单／关闭导航时记忆比例。

只有一个命令面板入口，action 为 `plugin.multi-model-workbench.open`。不占用默认快捷键，可在 Tern 中自行绑定。其他操作在任务阶段、详情或“⋯”菜单中，不再堆成一组全局命令。

## 方案与审批

新任务的产物路径：

```text
.omp/workbench/tasks/<task-id>/design.md
```

设计请求指定任务身份和起始 HEAD，要求仅研究方案、不实施代码，唯一允许写入的是该 Markdown 产物及其父目录。文件以以下元数据开头：

```yaml
---
workbench_task: <task-id>
workbench_baseline: <design-head>
---
```

- 设计会话的 `agent_finished=done` 必须与本任务的请求标记对应，才会检查产物。其他聊天回复不算本任务交付；`idle` 不代表完成。
- 产物必须是项目内 UTF-8 Markdown 普通文件，非空且不超过 128 KiB；拒绝穿越路径和指向项目外的符号链接。身份／基线不一致不能进入审批。
- 如果恢复后没有自动读取，或设计回合结束但交付不完整，使用“检查方案交付”；可以在原会话继续处理，不需要手工搬运聊天文本。
- 审批读取完整正文、HEAD 与 SHA-256。确认后再次读取；新会话启动准备完成后也再次核对。任一变化都使本次审批失效，不发送。
- 预览隐藏元数据，较长方案在有界区域滚动；超过 18000 字节时明确提示是节选，可打开完整文件。**发送的获批正文不截短**。
- 这些是工作流校验和提示约束，不是 OS 沙箱，也不是设计模型工具权限的强制白名单。批准前仍需核实项目实际改动。

旧版 Canvas 的任务简述、会话关联和设计路径可迁移，但不恢复任何旧审批。

## 原生工具与恢复

- 文件、Git 和 `/review` 复用 Tern／omp 内置能力，没有另建审查引擎或 `mm-review`。打开原生审查后仍需在 omp 选择范围；工作台不会自动开始推理审查。
- AGY 仅在你点击后复制交接文本，不启动 AGY，不走它的 headless 或自动 fallback。
- 中断只向当前任务的已关联会话发送原生中断，不回滚文件、不关闭会话，也不保证停止所有后台工具。
- 请求投递异常显示“发送状态待确认”，不自动重发。SDK 接受请求不等于模型完成，更不等于验证通过。
- 任务小状态保存在插件 `tern.kv`；完整方案、聊天、凭据、确认窗口和审批不写入 KV。运行中任务恢复为“需要你处理”，保留会话线索，不自动续发。
- 中文多行表单支持 IME、选择、粘贴、撤销、Ctrl+Enter 和 Esc。跨插件重载保存草稿和策略；已提交表单用 token 收据防止重复提交。Esc 仅放弃当前表单，不创建任务、不发送请求。
- 同一工作台阻止本工作流其他已知执行任务仍在工作时启动新的主要写入者；不保证控制工作台之外的写入者。
- 同项目多窗口并发修改 KV 不是事务级 exactly-once；建议一个窗口管理一个项目的任务集合。

Windows Git 对 WSL UNC 的 ownership 信任错误会原样报告，不自动修改 `safe.directory`。可在 WSL 原终端查看 Git，或自行审核精确目录信任。

### WSL 启动边界

Tern 的启动命令交给已配置的 WSL shell，因此必须传入 Linux 命令，不能再套一层 `wsl.exe`：额外的 ConPTY 会丢弃 TSP APC 握手；旧的重复包装也曾使带引号参数报 `Wsl/E_INVALIDARG`。插件通过 argv 进程准备私有启动桥接，将目录、发行版和角色编码成 base64 数据，避免把路径插入 shell 文本。桥接位于 WSL `/tmp/tern-workbench-launch-<uid>/launch.py`，目录权限 0700，原子更新；它不是常驻进程，临时目录被清理后会按需重建。

桥接从正常登录 shell 启动 `omp --cwd … --model @design/@execute`，不禁用扩展，不指定新 profile，不接触认证数据。WSL `--exec` 不传递终端身份时，桥接给该子进程补回 `TERM_PROGRAM=tern`，由真实 TSP 握手确认原生能力；不覆盖 `PI_TUI_NATIVE` 用户开关。原生会话投递需要启用 Tern 的 Native program surfaces。

Windows 可能把原生 Linux 会话目录报告成 `\tmp\…`。只有本机 host、当前插件启动命令及其项目／发行版载荷都匹配时，才还原为 WSL 路径；不会因此接受任意 Windows 根路径或远程 POSIX 会话。从这些新会话也能重新打开导航。

## 安装、卸载与文件

源码：`/home/jackie/code/workbench`。远端仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。

```sh
tern plugin link '\\wsl.localhost\Ubuntu\home\jackie\code\workbench'
tern plugin reload multi-model-workbench --json
tern plugin list --json
```

修改 linked 源码可能触发自动重载；跨 WSL 文件监视不可靠时显式 reload。重载不会执行任务或恢复审批。

卸载前关闭导航／表单，再执行 `tern plugin unlink multi-model-workbench`。这不会删除源码、项目产物、omp 配置或登录信息。卸载后的旧 Canvas 可能保留最后快照，但按钮无处理器，关闭即可。

| 文件 | 职责 |
| --- | --- |
| `window.luau` | 本窗口导航、会话身份、阶段操作、显式确认、恢复与事件合并 |
| `host.luau` | 原生中文任务表单、UTF-16 编辑事件与持久草稿 |
| `lib/tasks.luau` | 任务小状态、旧任务迁移、产物身份与恢复规则 |
| `lib/project.luau` | WSL argv 文件快照及无引号启动桥接 |
| `lib/policy.luau` | 目标就绪条件和审批指纹比较 |
| `lib/view.luau`、`styles.css` | 主题自适应的紧凑任务界面及有界滚动 |
| `tests/tasks.luau`、`tests/policy.luau` | 任务产物、恢复及原生 WSL 身份边界回归 |

## 验证记录（2026-11-11）

使用真实 Windows Tern 独立窗口及临时 Git 项目，不向用户工作会话提交任务：

- 原生加载 2.0.0，插件状态 ready、problems 为空。
- 任务导航、中文／emoji／多行表单、两种策略、行内确认和取消实际交互。
- 表单重载后保留内容，Esc 返回不创建任务；直接执行准备为 `@execute`，取消不发送。
- 真实 Markdown 产物读取；审批过程中修改正文，点击确认后明确拒发，未新增会话。
- 1280×800 窄面板实测审批主按钮在可见区域；方案只展示一次，滚动使用 SDK 支持的 `lines` 单位。
- `@design` 正常启动显示 GPT-5.6 Sol；含中文和空格的目录中 `@execute` 正常启动显示 DeepSeek-Flash。没有发送模型推理任务；这不用于判断模型质量、额度或代理健康。
- 任务契约回归通过 9 项：交付归属、基线变化、空正文、路径穿越、恢复身份、不持久化审批／全文以及损坏存储保护。
- 原生 `cx.agents:start` 在中文空格目录中投递 `/review`，真实 TSP surface 打开 Review Mode 范围选择器；Esc 退出菜单，没有启动模型审查。原生路径身份可恢复为对应 WSL 项目。
- 身份回归通过 11 项：原生路径关联、任意 Windows／远程路径拒绝、项目与发行版匹配、模型及状态门禁、已有 UNC 会话兼容、从原生工作会话恢复导航。连同任务契约共 20 项。

未宣称：完成真实设计或实施任务、跑模型审查、核实计费与额度、强制终止后台工具、跨窗口并发事务保证。

## 设计依据

遵循官方 [Designing Views](https://docs.stencil.so/tern/guides/design.md)、[输入编辑协议](https://docs.stencil.so/tern/elements/input.md)、[布局与滚动单位](https://docs.stencil.so/tern/elements/layout.md)、[存储与异步 I/O](https://docs.stencil.so/tern/guides/io.md) 和 [TSP 握手](https://docs.stencil.so/tern/protocol/handshake.md)。交互参考 [Overseer](https://github.com/mmnavarr/overseer) 的任务导航、渐进展开和上下文确认；未安装 Overseer 或照搬其 macOS／Worktrunk 依赖。
