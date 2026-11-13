# R2：统一交接面板、逐项批准差异与需求归属的草稿

- 日期：2026-11-13
- 状态：已实施，自动回归通过；V07/V09 的关键桌面路径与 V08 的持久未知投递审计已执行，其余桌面收发时序仍未执行。桥接层的预览漂移、重复意图与令牌复用由既有 Bun 测试覆盖。
- 依据：[重设计提案](REDESIGN_PROPOSAL.md) §3.1、§5-§6.1、[实施计划](REDESIGN_IMPLEMENTATION_PLAN.md) R2。

## 1. 交付范围

| 内容 | 位置 |
| --- | --- |
| “准备交接”内联面板：资料、完整预览、预填／发送两个独立动作 | `lib/handoff.luau#preparePanel`、`lib/ui.luau`、`host.luau#handoff-prepare` |
| 方案标签只保留方案与批准；资料从工作区标签移除 | `lib/handoff.luau` |
| 每项需求独立的交接草稿（最多保留 4 份，LRU） | `host.luau` 的 `saveCurrentDraft`／`loadDraft`、`handoffSnapshot`／`makeHandoff` |
| 跨需求预览发送拒绝 | `host.luau#sendPreview` |
| 回执与内部发送状态的统一词汇 | `handoff.receipt`／`handoff.sendState` |
| 与上次批准的逐项差异、完整旧内容、方案版本比较 | `Workflow.approvalDiff`、`Validity.contentDiff`、`handoff.approvalDiffCard` |

行为约束：

- 打开面板只切换可见性，不生成预览、不创建请求、不发送；面板中的“只预填”和“明确发送”是两个按钮。
- 草稿按 `requirementId` 保存；切换需求时先保存再载入。预览与发送都核对 `preview.requirementId`，属于另一项需求的预览不会被发送。
- 旧快照（单一未命名草稿）在升级后归属到最后选中的需求，避免丢失用户文本。
- 批准差异只使用既有 `Approval.requirementContent`：缺失或损坏显示“无法比较”，不当作“没有变化”；完整旧内容可折叠查看，设计版本与指纹单独比较。
- 回执词汇区分预填、来源检查、已提交、拒绝、投递未知；内部状态（记录意图、仅意图、来源命令中）不冒充回执。任何阶段都不表示交付或验收。
- 采用方案、批准、直接授权都不会自动发送；源端仍重新核对批准、基线、需求摘要与预览令牌。

## 2. 未包含

- “复用上次交接”需要保留历史交接元数据（E9），本轮没有新增持久历史；目前只能基于当前内存预览重试，且必须重新生成预览。
- 结构化审查导入、计划关联与增量审查属于 R5。
- 批量验证与选择性失效属于 R3／R6，未触碰。

## 3. 实际运行

环境：WSL Ubuntu；Lune 0.11.1；Bun 1.3.14。

| 命令 | 结果 |
| --- | --- |
| `lune run tests/run-views.luau` | 1137 checks, 0 failures |
| `lune run tests/run-host.luau` | 62 checks, 0 failures |
| `lune run tests/run-validity.luau` | 64 checks, 0 failures |
| `bun test omp/` | 34 pass, 0 fail |

新增覆盖：

- 面板关闭时没有预填／发送动作；打开后两者同时存在；空闲可发送，忙碌禁用；打开面板不产生工作流请求。
- 两项需求之间切换：资料草稿不串用，切回恢复；切换时保存原草稿。
- 批准差异：内容变化为警告并列出字段；一致时不警告；快照损坏明确不可比较；嵌套验收条件与标签变化可检测；缺失尾部字段不补齐为相同。
- 回执词汇：预填／检查／提交／拒绝／投递未知分别映射，不再把 `submitted` 当作成功。

## 4. 验收矩阵

| ID | 状态 |
| --- | --- |
| V07 | 桌面已执行：需求 A/C 草稿隔离与切回恢复；A 生成完整预览；C 不显示跨需求预览；omp 已有草稿时预填被拒绝并记录 `draft_conflict`；忙碌来源显示“工作中／正在使用 bash”。未执行成功预填/发送与真实任务忙碌下的按钮截图 |
| V08 | 桌面已执行：持久 `delivery_unknown` 请求与显式人工对账在审计中可见；预填因 omp 已存在草稿被拒绝，未重发。未执行桌面重复点击、迟到/乱序回执和实时刷新 |
| V09 | 桌面已执行：批准页显示旧快照完整内容与当前范围差异；内容漂移后提示必须重新授权；检查基线后点击批准返回 `design_not_current`，批准数量保持 1。“比较后再次变化”的二次快照未单独执行 |

## 5. 已知限制

- 草稿最多保留 4 项需求，其余在切换时被淘汰（显式上限，不静默覆盖当前项）。
- `sourceReceipt` 来自来源命令回执；`consumed`／`ended`／`accepted` 只作为词汇适配，当前协议没有对应事件，界面不会伪造这些阶段。
- 批准页仍包含方案与批准两个子标签；工作区级“一个主操作”与卡片级主按钮并存的问题保留到后续视觉整理。

## 6. 真实桌面记录（2026-11-13）

环境：Tern 0.9.18、Windows 11、WSL2、omp 18.20.0；隔离会话与 `/tmp/wb-r2-direct` 测试工程，未使用 rtc-middleware 数据，未修改全局插件/模型。夹具由生产 schema 的直接 JSON 生成，读取用 `Store.readRequirements`、`Workflow.load`、`approvalState`、`approvalDiff` 校验。截图在 `target/r2-desktop/`。

| 操作 | 结果 | 证据 |
| --- | --- | --- |
| 在两个需求分别输入中文草稿并切回 | A 的 `DRAFT-A-保留` 与 C 的 `DRAFT-C-隔离` 各自恢复，没有串用 | `r2-draftA.png`、`r2-draftC3.png`、`r2-draftA2.png` |
| 需求 A 生成完整预览 | 显示冻结身份、字节与预填/发送按钮；面板打开本身未写工作流 | `r2-previewA.png` |
| 切到需求 C 并打开面板 | A 的预览不出现，C 没有可发送预览 | `r2-activity2.png` 后的会话状态；自动回归覆盖同一拒绝 |
| omp 输入已有 `EXISTING-OMP-DRAFT` 时预填 | 来源回执 `rejected`、`reason=draft_conflict`；omp 草稿未被覆盖，未发送 | `r2-prefill-conflict.png`；运行时 receipts |
| 批准页差异 | 显示批准时完整旧内容（范围 `old scope`）与当前 `new scope: changed after approval`，警告“必须重新授权” | `r2-approval4.png` |
| 内容漂移后检查基线并批准 | 基线成功回执后点击批准仍返回 `design_not_current`；批准记录仍为 1 条 | `r2-approve-drift.png` |
| 持久未知投递 | 审计显示 `delivery_unknown`、回执原因与人工对账说明，未自动重发 | `r2-approval.png` 对应历史审计文本 |
| 忙碌来源 | 在来源心跳持续的情况下将快照写为 `working`，界面显示“omp 工作中／正在使用 bash” | `r2-busy9.png` |

限制：

- 工作台 surface 仍不在原生 a11y 树中。
- 忙碌状态通过快照写入模拟，未运行真实模型任务；因此未截取忙碌时发送按钮禁用，自动回归覆盖该条件。
- 未执行真实成功预填/发送、重复点击、迟到/乱序回执和刷新后的未知投递卡片；这些仍由桥接测试与后续桌面场景负责。
- 测试会话关闭后 Tern 可能保留空会话条目；未影响用户会话。
