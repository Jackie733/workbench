# Tern 需求交付工作台

一个现有 omp＋一个原位工作台。讨论、设计、实施和审查复用同一会话；工作台读取真实状态、工具和结构化计划，不另开 omp，不修改模型配置。

仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。本机源码：`/home/jackie/code/workbench`。

## 当前范围

阶段 0＋1 实时桥接、阶段 1.5 收尾、阶段 2 项目存储与原生需求界面，以及阶段 3 资料交接／正式方案／批准已实现：完整资料预览、显式预填或发送、不可变方案版本、真实差异与批注、批准失效、快捷实施授权和未知投递人工对账。阶段 4 的执行证据、阶段 5 的审查／验收／审计与阶段 6 的迁移仍未实现，不将会话活动误报为完整需求交付。

- [完整产品设计与分阶段计划](DESIGN_AND_IMPLEMENTATION_PLAN.md)
- [阶段 0＋1 实际协议、激活方式与验证记录](docs/PHASE_0_1.md)
- [阶段 1.5 收尾与阶段 2 存储层协议](docs/PHASE_2_STORAGE.md)
- [阶段 2 原生界面、操作方式与真实桌面验证](docs/PHASE_2_UI.md)
- [阶段 3 资料交接、正式方案与批准](docs/PHASE_3.md)
- [阶段 0 领域、存储、迁移与恢复契约](docs/DOMAIN_CONTRACT.md)
- [旧版 2.0.0 历史说明](docs/LEGACY_WORKBENCH_2_0.md)：仅供迁移参考，不再按其双角色启动流程使用。

## 在当前 omp 使用

本机已添加 `~/.omp/agent/extensions/workbench.ts`，仅重导出仓库扩展；没有自动重载日常会话。方便时在现有 omp 执行 `/reload-plugins`，然后 `/wb`。它只打开右侧工作台，不启动另一个 omp。

下次启动开发／调试会话可使用 `omp --model openai-codex/gpt-6-luna`；不改变全局默认模型。其他机器可显式加载 `omp --extension /absolute/path/to/workbench/omp/index.ts`。不要同时配置两个相同扩展入口；无需安装 skill、Provider 或新后台服务。

当前插件版本 3.2.0。阶段 2 已通过 55 项真实存储、13 项同时写入和 9 项中断恢复检查；阶段 3 的协议与批准门禁通过 23 项自动测试，并在真实 Tern／Luna 会话完成预览、预填、发送、批注、版本差异、基线失效与未知投递对账。运行方法与限制见阶段记录；不以源码测试替代 UI 验证。


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
