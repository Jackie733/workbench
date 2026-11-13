# Tern 需求交付工作台

一个现有 omp＋一个原位工作台。讨论、设计、实施和审查复用同一会话；工作台读取真实状态、工具和结构化计划，不另开 omp，不修改模型配置。

仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。本机源码：`/home/jackie/code/workbench`。

## 当前范围

阶段 0＋1 实时桥接、阶段 1.5 收尾、阶段 2 项目存储与原生需求界面、阶段 3 资料交接／正式方案／批准、阶段 4 实施计划／代码结果／验证证据，以及阶段 5 审查／人工验收／审计／导出已实现：完整资料预览、批准失效、稳定计划、真实 Git 差异、可失效验证证据、追加式审查与发现处置、人工接受／驳回／重新打开，以及按需求审计时间线和安全 Markdown 导出。阶段 6 **明确不迁移**旧 KV 任务与旧方案：快速迭代期保留旧数据原样，不读取、不删除；已清理旧角色启动与旧入口代码。[阶段 6 决定](docs/PHASE_6.md)说明未做的发布验收，不将其冒称已完成。

- [完整产品设计与分阶段计划](DESIGN_AND_IMPLEMENTATION_PLAN.md)
- [阶段 0＋1 实际协议、激活方式与验证记录](docs/PHASE_0_1.md)
- [阶段 1.5 收尾与阶段 2 存储层协议](docs/PHASE_2_STORAGE.md)
- [阶段 2 原生界面、操作方式与真实桌面验证](docs/PHASE_2_UI.md)
- [阶段 3 资料交接、正式方案与批准](docs/PHASE_3.md)
- [阶段 4 实施计划、代码结果与验证证据](docs/PHASE_4.md)
- [阶段 5 审查、人工验收、审计与导出](docs/PHASE_5.md)
- [阶段 6 迁移决定与旧入口清理](docs/PHASE_6.md)
- [阶段 0 领域、存储、迁移与恢复契约](docs/DOMAIN_CONTRACT.md)
- [重设计提案](docs/REDESIGN_PROPOSAL.md)、[证据登记](docs/REDESIGN_RESEARCH.md)、[执行计划](docs/REDESIGN_IMPLEMENTATION_PLAN.md)、[R0](docs/REDESIGN_R0.md)、[R1](docs/REDESIGN_R1.md)、[R2](docs/REDESIGN_R2.md)、[R3a](docs/REDESIGN_R3A.md)、[R3b](docs/REDESIGN_R3B.md)、[R4a 完成记录](docs/REDESIGN_R4A.md) 与 [能力探针结果](docs/REDESIGN_PROBES.md)
- [旧版 2.0.0 历史说明](docs/LEGACY_WORKBENCH_2_0.md)：仅作历史参考，相关代码已删除；旧数据不迁移。

## 在当前 omp 使用

本机已添加 `~/.omp/agent/extensions/workbench.ts`，仅重导出仓库扩展；没有自动重载日常会话。方便时在现有 omp 执行 `/reload-plugins`，然后 `/wb`。它只打开右侧工作台，不启动另一个 omp。

下次启动开发／调试会话可使用 `omp --model openai-codex/gpt-6-luna`；不改变全局默认模型。其他机器可显式加载 `omp --extension /absolute/path/to/workbench/omp/index.ts`。不要同时配置两个相同扩展入口；无需安装 skill、Provider 或新后台服务。

当前插件版本 3.7.1。阶段 2 已通过 55 项真实存储、13 项同时写入和 9 项中断恢复检查；阶段 3 的协议与批准门禁通过自动测试，并在真实 Tern／Luna 会话完成预览、预填、发送、批注、版本差异、基线失效与未知投递对账；阶段 4 在隔离 Git 项目中真实执行失败／通过验证并确认失效与归属边界；阶段 5 真实完成原生 `/review` 预填、阻断审查、发现处置、人工接受、审计检索、导出与重新打开，确认导出不夹带验证输出或聊天。阶段 6 不迁移旧数据，只做旧入口清理；未完成发布验收，不以旧证据替代。3.7.0 的审查页试点通过 988 项视图契约与 33 项真实宿主交互自动检查（`lune run tests/run-views.luau`、`lune run tests/run-host.luau`），并修复芯片动作值丢失回归；新界面的真实桌面渲染验收尚未另行执行，不以自动检查替代。


## 运行边界

- `/wb` 关联实际调用会话。身份缺失、来源不唯一或 session 已改变时拒绝误投，不猜测第一个窗口或同目录空闲会话。
- 当前状态、工具、计划和候选交付均为观测。没有可靠需求归属时明确标注，不自动推进生命周期。
- 资料预填不触发推理；已有草稿不覆盖，忙碌时不默认 steer，不自动重试不确定请求。
- 关闭／重载面板不关闭 omp，不自动重发请求；断连明确显示过期状态。
- 运行 IPC 留在当前用户私有临时目录；项目需求仅在明确初始化后写入 `.omp/workbench/`，不自动迁移旧业务数据。初始化提供本仓库私有排除或遵循现有 Git 规则的选择。
- 工作台不是工具权限沙箱，本地日志也不是防篡改审计系统。

## Tern 本地链接

在 Windows Tern 可访问该 WSL 仓库的环境中：

```sh
tern plugin link '\\wsl.localhost\Ubuntu\home\jackie\code\workbench'
tern plugin reload multi-model-workbench --json
tern plugin list --json
```

插件 ID 保持 `multi-model-workbench`，避免目录改名导致安装和数据身份变化。链接源码更新可能触发重载；显式 reload 会影响插件面板，不应在用户未完成输入时随意执行。

本项目不安装 Provider、skill，不保存认证信息，不更改默认模型或 fallback，不自动提交、推送、合并或发布。
