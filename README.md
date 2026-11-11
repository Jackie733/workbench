# Tern 需求交付工作台

一个现有 omp＋一个原位工作台。讨论、设计、实施和审查复用同一会话；工作台读取真实状态、工具和结构化计划，不另开 omp，不修改模型配置。

仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。本机源码：`/home/jackie/code/workbench`。

## 当前范围

本次实施阶段 0＋阶段 1：领域／恢复契约，以及当前 omp 与 Tern 原生面板之间的实时观测和资料预填链路。需求池、完整看板、正式审批、业务持久化、代码证据和审计验收属于后续阶段，不将会话活动误报为完整需求交付。

- [完整产品设计与分阶段计划](DESIGN_AND_IMPLEMENTATION_PLAN.md)
- [阶段 0＋1 实际协议、激活方式与验证记录](docs/PHASE_0_1.md)
- [阶段 0 领域、存储、迁移与恢复契约](docs/DOMAIN_CONTRACT.md)
- [旧版 2.0.0 历史说明](docs/LEGACY_WORKBENCH_2_0.md)：仅供迁移参考，不再按其双角色启动流程使用。

## 在当前 omp 使用

本机已添加 `~/.omp/agent/extensions/workbench.ts`，仅重导出仓库扩展；没有自动重载日常会话。方便时在现有 omp 执行 `/reload-plugins`，然后 `/wb`。它只打开右侧工作台，不启动另一个 omp。

下次启动开发／调试会话可使用 `omp --model openai-codex/gpt-6-luna`；不改变全局默认模型。其他机器可显式加载 `omp --extension /absolute/path/to/workbench/omp/index.ts`。不要同时配置两个相同扩展入口；无需安装 skill、Provider 或新后台服务。

当前插件版本 3.0.0。协议边界回归：`bun test omp/runtime.test.ts`。真实桌面验证与已知限制见上方阶段记录，不将源码测试替代 UI 验证。


## 运行边界

- `/wb` 关联实际调用会话。身份缺失、来源不唯一或 session 已改变时拒绝误投，不猜测第一个窗口或同目录空闲会话。
- 当前状态、工具、计划和候选交付均为观测。没有可靠需求归属时明确标注，不自动推进生命周期。
- 资料预填不触发推理；已有草稿不覆盖，忙碌时不默认 steer，不自动重试不确定请求。
- 关闭／重载面板不关闭 omp，不自动重发请求；断连明确显示过期状态。
- 运行文件在当前用户私有临时目录，不写入 Git；旧 KV 任务和项目方案保留，阶段 1 不迁移业务数据。
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
