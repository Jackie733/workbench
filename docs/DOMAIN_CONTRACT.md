# 当前领域约束与版本基线

本文是新设计必须遵守的约束，不是完整 JSON Schema，也不是新能力已实现的声明。产品目标见 [DESIGN](DESIGN.md)，实施与验证进度只记在 [TASKS](TASKS.md)。早期包含目标字段、未实施事务与废弃迁移计划的原契约已[归档](archive/2026-11-13/docs/DOMAIN_CONTRACT.md)。

## 1. 基线来源与适用范围

下表由 AF-01 对当前读写器静态核对（2026-11-13）；版本矩阵本身不是运行通过记录。本次隔离回归与能力探针结果见 TASKS；未迁移业务数据或执行原生故障恢复场景。

| 实体 | 当前 Luau 读取版本 | 当前正常新写版本 | 当前依据 |
| --- | --- | --- | --- |
| project | 1 | 1 | `Store.validateProject/newProject` |
| requirement | 1/2 | 2 | `Store.validateRequirement/put/upgradeRequirement` |
| workflow、正式方案 | 1/2 | 2 | `Store.validateWorkflow`、`Workflow.load/persist/readDesign/apply` |
| results、验证 evidence | 1/2 | 2 | `Results.validateResults/addVerification`、`Store.putScoped` |
| plan | 1/2 | 2 | `Results.validatePlan/planAction/adoptCandidate` |
| reviews | 1/2/3 | 3 | `Review.validate/createReview/recordAcceptance/adoptCandidate` |
| resources、项目锁 | 1 | 1 | `Resources.validate`、`Store.atomicScript/lockValue` |
| IPC command/receipt/open ack；外部 plan/review 候选 | 1 | 1 | `omp/runtime.ts`、`Candidates.validate`；候选不是正式实体 |

plan v2 才允许步骤的 criterionIds/filePaths 与容器 candidateImports；reviews v3 才允许 candidateImports。旧记录的内容身份缺失保持缺失，升级容器不重绑旧批准、验证或验收。新 Agent 工具信封尚无已完成协议版本。

### 1.1 两端与内嵌读写器边界

- `omp/handoff.ts` 只读取 project v1、requirement/workflow/design v1/2，并严格核对授权所需字段；不读写 plan/reviews/results，因此不是全库兼容读写器。
- `Store.atomicScript` 在发布前读取现存目标，仅检查对象、schema 与 revision/CAS：默认 v1；调用方设置 OMPWB_SCHEMA2 时，requirement/workflow/plan/results/reviews 与 verification evidence 路径接受 v2；OMPWB_SCHEMA3 仅让 reviews 接受 v3。正式方案只创建，不走现存方案覆盖。此 PowerShell 层**不**执行完整领域字段验证，不能等同 Luau 验证器。
- Luau 领域验证器使用字段白名单，未知字段/未知版本拒绝；requirement.extensions 是显式允许的扩展对象，不能据此声称递归拒绝所有未知键。IPC command 有字段白名单，但 `matchingOpenAck` 仅验证所需身份/时间/面板字段，并未拒绝所有额外字段；不得把业务实体的严格规则泛化到全部 IPC。

## 2. 身份与写入

- projectId、requirementId 是稳定身份；展示编号、路径、当前选择和窗口焦点都不能替代身份。
- requestId、omp sessionId、进程 instanceId 与 Tern window/pane 分开绑定；来源不唯一、切换会话或来源失效时拒绝发送。
- revision 是实体 CAS 修订，每次写入递增。预期版本不符则保留草稿并报告冲突，不采用最后写入覆盖。
- contentRevision 是最近一次内容变动的单调身份，与实体修订分离；标题、类型、优先级、目标、范围、验收条件和标签属于当前保守内容集合。
- 内容 A→B→A 仍产生新身份，不能复活旧批准。旧条目不回填虚构内容身份或来源，按原保守规则判断。
- 预览与发送继续绑定精确实体修订、源内容、目标与有效期；不得因引入内容身份而放松预览漂移检查。

## 3. 状态与归属

四种事实必须分离：持久生命周期、请求运行状态、连接新鲜度、只读派生 readiness。

持久阶段：backlog、clarifying、designing、awaiting_approval、implementing、verifying、awaiting_acceptance、done、blocked、cancelled。新看板分组仅作投影，不重命名持久枚举，不拖拽改变阶段。

- 查看、搜索、切换标签、展开内容和重算 readiness 不写业务状态、不启动模型。
- 被动 idle、工具成功、模型完成声明不自动推进生命周期或人工验收。
- 明确命令可按既有契约记录相应转换，必须保留原请求归属；查看 B 不能把 A 的运行与证据改归 B。
- 单个工作台工作流只认领一个活动请求，不引入隐藏队列、并行调度或自动 steer。
- 观测 todo 的归属未知时保持未知；不能靠当前选中需求、文件重叠或自然语言猜测身份。

AF-03 已开始将 lifecycle、request、connection 与 readiness 分开呈现：待核对请求不等于执行中，断连不宣称新鲜就绪。有效批准的“查看实施准备”只是导航，切换活动会失效旧预览；真正发送仍走既有源端/领域门禁。现存导航补记历史基线的例外仍未清除，不能将纯读计算推广为所有导航均零业务写入。

## 4. 授权、证据与验收

- 批准绑定需求内容、具体方案与实施前基线；确认时重新读取并校验。批准与开始实施分开。
- 新内容、方案或相关基线变化按现有规则失效授权；生命周期变化不错误失效新格式内容授权。
- 实施后的预期代码变化不能反向假装用户批准了新的需求范围。外部混合编辑不宣称精确作者归属。
- 验证结果来自真实执行器，绑定需求内容与代码快照，保留准确命令、目录、退出码和必要输出；模型不能写入通过结论。
- 当前生产策略仍按全局代码快照判断证据有效性；条件到文件的关联仅为计划意图，不构成选择性复用依据。
- 未执行、失败、过期、未知和通过不得混为一谈；没有验收条件不得把绿色 0/0 当作覆盖成功。
- 必需条件缺少有效证据或仍有阻断发现时拒绝验收。修改条件属性是需求编辑，不是免除失败检查的隐式捷径。
- 发现的明确处置/豁免须保留理由与历史；零发现的新审查不抹去旧阻断。最终验收只能由人触发，Agent 不得代答。
- 直接实施仍需要范围、验收条件、理由与明确授权，不按任务类型自动豁免。

## 5. 生命周期、停止与恢复

阻塞/解除/取消/重开保留原因和历史；有活动或待核对操作时遵守现有转换门禁。取消需求不表示进程终止，停止调度不等于杀死当前命令，停止请求只有收到可信确认才能显示已停止。

未知投递先核对，不默认重发；关闭面板不关闭 omp；重载不恢复执行、不自动消费旧预览、不复活旧批准。新工具幂等协议必须包含同键异载荷拒绝、重复结果核对和持久化恢复边界，不宣称网络“恰好一次”。

## 6. 存储与兼容

正式资料仍在项目 `.omp/workbench/`，IPC 留在用户私有临时目录。当前基线采用项目锁、单文件 CAS、同目录临时发布与创建 staging；不把早期设计中的跨文件事务日志当作已经存在的实现。

- 未知版本、损坏数据、非法字段保留原始数据并拒绝不安全写入，不能按空库重建。
- 当前业务历史必须保留，包括混合版本实体、方案、批准、采用清单、证据与验收。
- 正常写入时按已有协议升级；纯 UI 改造不升级 schema，不批量改写数据。
- 新字段与新协议先定义读写矩阵、上限、旧端拒绝、发布顺序与部分失败恢复；跨文件修改不能未经设计宣称原子。
- 回滚新数据需要一致目录备份与匹配读写器，不允许只改 schema 数字或单文件恢复。
- 旧 KV 与 `.omp/workbench/tasks` 继续不迁移、不读取、不删除；这不允许丢弃当前 requirements 数据。

### 6.1 已核对的发布顺序与恢复边界

- 项目锁 token 与 `.gate` 独占句柄保护单次发布；锁过期阈值为 15 秒，接管仍需显式 takeover。PowerShell 使用同目录临时文件和 MoveFileEx（创建不覆盖、更新替换）；这是单文件 CAS，不是跨实体事务，也不阻止绕过协议的外部编辑。
- 创建需求：先在 `.pending-*` staging 写 requirement，再 CAS 增加 project 的 nextNumber/revision，最后发布需求目录。超时/进程结果不确定时保留 staging；没有启动时扫描 staging 自动完成事务的恢复器。分配后发布失败可能留下编号空洞。相同需求 ID、相同内容可由 `Store.create` 重读返回既有需求，不同内容报冲突。
- 采用正式方案：先写不可变 designs/vN.json，再按需写 requirement 阶段，最后写 workflow 元数据。相同孤立方案正文/身份/source 可复用，异内容报 immutable_design_conflict；这不是任意中断点均自动恢复的保证。
- 验证：先创建不可变 evidence/verification-*.json，再 CAS 发布 results 摘要。第二步失败或首步成功后回调丢失可留下未索引证据；`addVerification` 没有扫描/合并孤立 evidence 的恢复器，同 ID 重试可能遇到创建冲突，已索引同 ID 返回 verification_exists。不能把运行命令或结果写入自动重试包装成“恰好一次”。
- plan/review 外部候选的采用清单与正式条目在各自单文件中同时 CAS 发布；同 ID 同指纹返回既有容器，同 ID 异指纹拒绝。此幂等性不延伸到所有工作流动作或执行命令。
- 单文件写入成功后回调丢失，磁盘是事实来源：重读可观察已提交 revision，旧预期修订重试应冲突；它不意味着丢失的业务回调或跨文件后续步骤会自动补做。`tests/native-lifecycle.luau` 有真实 FS/PowerShell、仅丢回调的分阶段场景；本次只检查其源码，未执行。
- `omp/runtime.ts` 的 IPC JSON 用独占临时文件、fsync、rename 与目录同步发布，不是业务实体 CAS。每个 Runtime 创建新 instanceId 私有目录；receipt 存在性可供调用端判重，但 Runtime 本身没有载荷摘要幂等账本或跨实例执行恢复。旧死进程目录可被清理，IPC 不是永久业务审计。

### 6.2 证据结构与未消除差异

- results 保存 baseline、changes（fingerprint、文件/提交/diff 及截断标志）、verifications 摘要；完整输出另在不可变 evidence 文件。摘要包含准确 command/cwd、条件 ID、需求修订/可选内容身份、代码快照、起止时间、可选退出码、超时、passed/failed/unknown、输出预览/字节数/截断标志及 evidencePath。完整文件保存 stdout/stderr，但仍受大小/截断限制，不应称为无损无限日志。
- reviews 保留审查来源、范围、快照、需求身份、findings、处置 events，以及 acceptances/reopenings；外部候选采用额外保留 source/internal ID 映射与指纹，不升级为认证原生来源。审查零发现不清除旧阻断。
- `Validity` 是纯只读表计算：新记录按内容身份，旧记录按精确 revision；当前快照缺失时历史 passed 显示 unknown，历史 failed 不被隐藏。条件/文件关联不启用选择性快照复用。
- **当前实现差异：** `Validity.acceptance` 在存在快照、无必需条件、无未处置阻断发现时可返回 ok；它没有“零验收条件必须拒绝”的独立理由。`Review.recordAcceptance` 仅校验和保存记录，不自行调用 acceptanceGate 或证明人工点击；最终门禁与人工触发仍须由可信调用链强制执行。后续不得把这些底层函数当作独立安全写接口，本段不是放宽 §4 的产品约束。
- 可执行基线源码包括 `tests/run-content-identity.luau`（混合版本与未知字段/版本）、`tests/native-lifecycle.luau`（回调丢失/旧端拒绝）、`tests/native-candidate-adoption.luau`（plan1→2、reviews1/2→3、采用映射与重放）。源码里的断言是待运行场景，不是本次验收证据。

## 7. 外部候选与安全边界

外部 JSON 候选保留严格范围声明、完整性与大小限制、项目内路径校验、冻结预览及采用前重读。同 ID 同指纹重放返回既有结果，同 ID 异指纹冲突；不将声明的来源当作认证的原生审查。

新工具与 UI 共用领域命令，不允许模型提供人工批准身份、伪造证据或通过任意路径绕过存储器。可信权限来自宿主/运行时，不能由工具载荷自我授予。

工作台不是操作系统权限沙箱；本地审计不是防篡改日志。资料与导出应有界、脱敏，不自动复制完整聊天、环境变量或凭据。不改默认模型/Provider，不自动提交、推送、合并或发布。

## 8. 变更本契约

若实现确需改变此处约束，先在 DESIGN 与 TASKS 记录具体语义、兼容影响与验证要求；不得用 UI 简化作为放松授权的理由。完整字段定义以同步维护的真实验证器为实现依据；发现差异先解释，不以文档覆盖事实。
