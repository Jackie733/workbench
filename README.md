# Tern 需求交付工作台

一个现有 omp＋一个原位工作台。讨论、设计、实施和审查复用同一会话；工作台读取真实状态、工具和结构化计划，不另开 omp，不修改模型配置。

仓库：[Jackie733/workbench](https://github.com/Jackie733/workbench)。本机源码：`/home/jackie/code/workbench`。

## 当前状态与文档

现有实现包含需求存储、资料交接、方案批准、实施计划、Git 差异、验证证据、审查、人工验收和审计。Agent-first 重构已完成 AF-01 契约盘点，AF-02 隔离能力探针和 AF-03 读模型修正正在进行；新界面与 Agent 业务工具尚未完成，局部测试不代表完整发布验收通过。

| 文档 | 用途 |
| --- | --- |
| [设计文档](docs/DESIGN.md) | 当前产品、信息架构、交互、UI/色彩与 Agent 工具设计 |
| [任务清单](docs/TASKS.md) | 唯一实施进度入口；AF-01–AF-16 的依赖、交付物和验收标准 |
| [领域约束](docs/DOMAIN_CONTRACT.md) | 身份、授权、证据、状态、存储与版本兼容边界 |
| [历史归档](docs/archive/README.md) | 旧方案、阶段记录与真实验证限制，仅供追溯 |

旧文档已退出当前实施入口，不删除历史证据，也不据此清除尚未完成的验收事项。开始开发先读设计与领域约束，再按任务清单的实际状态和依赖继续；AF-02/03 未验收前不跳入新 UI 重构。

## 在当前 omp 使用

本机已添加 `~/.omp/agent/extensions/workbench.ts`，仅重导出仓库扩展；没有自动重载日常会话。方便时在现有 omp 执行 `/reload-plugins`，然后 `/wb`。它只打开右侧工作台，不启动另一个 omp。

下次启动开发／调试会话可使用 `omp --model openai-codex/gpt-6-luna`；不改变全局默认模型。其他机器可显式加载 `omp --extension /absolute/path/to/workbench/omp/index.ts`。不要同时配置两个相同扩展入口；无需安装 skill、Provider 或新后台服务。

当前插件版本 3.7.1。历史实现与验证详见归档；当前仍需关注真实收发时序、活动运行中的生命周期、批处理停止/重载、完整升级恢复，以及原生焦点、撤销与辅助技术支持。新任务清单承接这些边界，不将归档等同于关闭问题。

更新时须同步宿主和 omp 扩展。已记录版本包含需求等实体 schema 2、plan schema 2、reviews schema 3；精确矩阵见领域约束，旧条目不补造身份。新写入后不保证旧二进制可写或降级，请勿手改 schema 数字。旧 KV 与旧任务/方案仍不迁移、不读取、不删除。


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
