# 历史资料归档

此目录保留旧设计、实施记录和测试边界，不作为当前实施任务入口。旧文档中的“下一轮”“权威”“待实施”及授权表述均只适用于记录当时；没有完成的验收不会因归档而完成。

当前入口：[设计](../DESIGN.md)、[任务](../TASKS.md)、[领域约束](../DOMAIN_CONTRACT.md)。

## 归档规则

- 2026-11-13 归档旧根计划与原 docs 的 22 份材料，共 23 份；保留原来的相对目录结构，避免历史引用失联。
- 旧根计划、旧提案、旧任务和旧领域契约标明已被替代；阶段记录保留原文与真实限制。
- 截图仍在原 target 目录，可能是本机忽略产物，不复制、不伪造，也不保证其他机器存在。
- 旧 AGENT_FIRST_REDESIGN 已提升并更名为当前 DESIGN，不额外留第二份活跃设计。
- 历史记录不继续追加新任务；当前进度只更新 TASKS。

## 资料索引

| 类别 | 记录 |
| --- | --- |
| 旧产品计划 | [产品与实施计划](2026-11-13/DESIGN_AND_IMPLEMENTATION_PLAN.md) |
| 初始模型 | [阶段 0 领域契约](2026-11-13/docs/DOMAIN_CONTRACT.md) |
| 桥接与存储 | [阶段 0/1](2026-11-13/docs/PHASE_0_1.md)、[阶段 2 存储](2026-11-13/docs/PHASE_2_STORAGE.md)、[阶段 2 UI](2026-11-13/docs/PHASE_2_UI.md) |
| 业务流程 | [阶段 3](2026-11-13/docs/PHASE_3.md)、[阶段 4](2026-11-13/docs/PHASE_4.md)、[阶段 5](2026-11-13/docs/PHASE_5.md) |
| 旧版本边界 | [阶段 6 不迁移决定](2026-11-13/docs/PHASE_6.md)、[2.0 历史](2026-11-13/docs/LEGACY_WORKBENCH_2_0.md) |
| 上轮重设计 | [提案](2026-11-13/docs/REDESIGN_PROPOSAL.md)、[任务](2026-11-13/docs/REDESIGN_IMPLEMENTATION_PLAN.md)、[研究](2026-11-13/docs/REDESIGN_RESEARCH.md) |
| 共享有效性与壳层 | [R0](2026-11-13/docs/REDESIGN_R0.md)、[R1](2026-11-13/docs/REDESIGN_R1.md) |
| 交接与验证 | [R2](2026-11-13/docs/REDESIGN_R2.md)、[R3a](2026-11-13/docs/REDESIGN_R3A.md)、[R3b](2026-11-13/docs/REDESIGN_R3B.md) |
| 资源、内容身份、候选 | [R4a](2026-11-13/docs/REDESIGN_R4A.md)、[R4b](2026-11-13/docs/REDESIGN_R4B_DESIGN.md)、[R5](2026-11-13/docs/REDESIGN_R5.md) |
| 能力与桌面证据 | [探针](2026-11-13/docs/REDESIGN_PROBES.md)、[桌面与 IME](2026-11-13/docs/REDESIGN_DESKTOP.md) |

## 必须承接的未完成项

新 TASKS 的 AF-14/AF-15 承接真实收发乱序/未知结果、活动运行中的生命周期、批处理停止与重载、完整升级恢复、焦点/撤销与辅助技术限制。旧记录中的部分成功不关闭这些场景。选择性证据失效与增量审查不因归档进入新范围。
