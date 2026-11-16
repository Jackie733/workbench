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

### 7.1 AF-11 目标协议与版本栅栏（设计，未实施）

以下是与 DESIGN §7.3–7.11 配套的选定契约，**不改变 §1 的当前生产矩阵**。AF-11 只完成本轮设计部分；没有写入、迁移、恢复器或工具已实施的含义。所有新解析器采用递归白名单和明确容量，读未知版本时保留原文件并失败。

| 实体/通道 | 目标读取/写入 | 启用及旧端行为 |
| --- | --- | --- |
| live marker/snapshot、旧 command/receipt/open ack | 仍 v1/v1 | 不加字段、不改旧语义；工具另走私有 runtime `tools/` 通道 |
| `omp-workbench.tools` 信封/协商/响应 | protocolVersion 1；文件 schema v1 | 新两端 ready 后按能力交集开放；未知协议、操作、活动明确拒绝 |
| project | 读 1/2；未启用写 1，启用后写 2 | v2 只新增 `toolProtocol={protocolVersion:1,ledgerSchemaVersion:1,writerProtocol:2}`；旧 Store/TS 严格 reader 拒绝，绝不按空项目 |
| 项目锁 | 未启用仍 v1；启用后读写 v2 | v2 保留 token/owner/updatedAt，新增 `writerProtocol=2`、`released` 布尔；旧 PowerShell 的 lock key/schema 校验拒绝，连旧 scoped 写入/接管也不能绕开 |
| requirement/design/results/evidence/plan/reviews/resources | 保持 §1 原读写版本 | 不为工具归属给旧业务实体追加未知字段；操作归属放 sidecar。既有批准/证据/采用历史不回填 |
| workflow | 首版仍读 1/2、写 2 | tools 协商可列未来活动，v1 首版只启用 clarify/design/implement；review/analyze 需另行设计 workflow 新版及全链路门禁后发布 |
| `.omp/workbench/tools/leases/`、`grants/`、`candidates/`、`decisions/`、`operations/` | 新实体 schema v1；不存在不是可随意初始化的证据 | 只能在已明确启用的 project v2 与 lock v2 下创建；未知/损坏已有 sidecar 阻止写；缺操作账本不是“操作未执行”的证明 |

只升级 project 不够：旧 `Store.atomicScript` scoped 写只看目标与锁，不读 project；因此采用 **project v2＋lock v2 双栅栏**，不靠 UI 隐藏按钮。新 PowerShell 发布器每次在 `.gate` 下核对 project 声明、lock.writerProtocol 与目标 schema/修订；旧 direct 文件编辑不在保证内。新锁升级前停用所有旧 host/扩展、等待或核对活动/未知操作，显式接管原 v1 锁，取得一致目录备份。不能在旧 PowerShell 已通过锁检查而仍运行时切换。

升级发布顺序固定：在持有同一个 `.gate` 句柄期间复核原 v1 锁、发布 lock v2，再 CAS 发布 project v2，最后建立合法的空 tools 子目录（没有额外“空账本”或允许忽略的 manifest；首次实体创建均有 schema 校验）。新端看到 project1/lock2 是 upgrade_incomplete，只允许显式恢复升级/恢复备份，不执行业务；project2/lock1 或 tools 数据出现在未启用项目均是 protocol_fence_mismatch。缺失锁的 project2 只能由新端签发 lock2；这是新端的要求，不声称旧程序无法在用户主动删除锁后写坏项目。运行中发现锁被移除/降级立即停写。安装升级不自动做此项目升级。旧二进制实际拒绝 project2/lock2 的原生故障场景必须成为启用前证据，不能只用新 reader 的测试或 sidecar 声明代替。
lock v2 的 release 不再删除栅栏文件，而是在同一 gate 下 CAS 保留 schemaVersion=2/writerProtocol=2 并设 released=true；续租/持锁时为 false，旧 token 不得在 released 后发布。新端显式启用编辑才可认领 released 的锁并写新 token；过期锁继续显式 takeover，任何清理器不得按年龄删除 v2 栅栏。关闭面板、重启、正常释放后旧二进制仍必须拒绝；只有恢复整个旧目录的回滚流程才回到 lock v1。用户或外部程序主动删除/修改栅栏属于不受防篡改保证的越界行为，不自动据此初始化。


### 7.2 可信上下文与字段合同

- 来源：只接受原生 SDK execute 的 main 会话；子 Agent、RPC/print 尚未证明完整桥接/人工能力，首版写工具拒绝 `source_context_unavailable`，不得借用顶层状态。只读工具可在独立 main 上下文从可信 cwd 解析当前项目，不能从模型参数选择会话或项目根。
- `binding` 固定字段为 instanceId/sessionId/hostEpoch/openRequestId/leaseId/requestId/branchEpoch；hostEpoch、branchEpoch 是新端随机 epoch，启动/重载、session_switch/branch/tree 或 cwd 变化就轮换。额外绑定原生 window/sourcePane/panel 的握手记录，不把 ID 放进模型 schema 作为授权。ready 同时核对 offer/host 摘要、项目 root/projectId、6 秒活性和严格单调 sequence；进程 instance 改变旧消息永不执行。
- `expected` 是精确对象：requirementRevision、requirementContentRevision，以及操作触及/依赖的 planRevision/resultsRevision/workflowRevision/reviewsRevision；不存在容器 revision=0。无关实体字段禁止携带而非忽略。propose 绑定需求、plan/review 候选额外绑定计划与代码快照；update_plan 绑定 requirement/plan；request_decision 与 run_verification 按候选/验证实际依赖补齐。同内容身份不能替代精确 CAS 修订。
- lease v1 字段：schemaVersion/projectId/id/requirementId/requestId/binding/requirementRevision/requirementContentRevision/approvalRef/activity/capabilities/issuedAt/expiresAt/tokens；token 条目含随机 value、operation、expiresAt，生命周期 ≤24 小时；租约 ≤30 分钟。创建是明确人工动作，每次 64 token；模型读取令牌不生成新令牌。lease 的撤销使用同目录独立、不可变 revoked 记录（id、at、reason、hostEpoch），读时必须检查；不原地改变令牌清单。
- grant v1 字段：schemaVersion/projectId/requirementId/id/leaseId/requestId/approvalRef/requirementRevision/requirementContentRevision/command/cwd/criterionIds/timeoutMs/codeSnapshotSha256/issuedAt/expiresAt/decisionId；只由人工确认命令产生，expiresAt 不晚于 lease。认领关系由 operation 内 grantId 唯一索引核对，单写者同一时间仅一个进行中 operation，不能靠 Agent 自述“已确认”。
- candidate v1 字段：schemaVersion/projectId/requirementId/id/kind/source/expected/codeSnapshotSha256/payload/payloadSha256/createdAt；source 固定由 host 构造的 agent_candidate 与原始 request/operation/session 引用。kind=requirement/design/plan/review；requirement 是完整可校验目标内容草稿，不允许夹带 stage/批准/证据；design 是正文；plan/review 复用现有候选内容上限、完整范围与稳定外部 ID，但不是伪造的文件来源。采用只发生在人工命令，正式 source 仍按现有 schema 的 assistant/external 表达，精确工具来源另留 sidecar 引用。
- decision v1 字段：schemaVersion/projectId/requirementId/id/requestId/leaseId/kind/expected/candidateId/verificationSpec/reason/state/createdAt/resolution；kind 为 adopt_candidate 或 verification，candidateId/verificationSpec 二选一。state=pending/approved/rejected/expired，resolution 仅 host UI 写入，含 nonce 生成的可信动作引用、时间、理由和 resultingGrantId/采用结果 ID；工具不能传 resolution。过期由读取派生，显式写决定时记录 expired，不以后台任务改业务。采用/批准后内容变动仍可使事项 stale，原决定不改写成新授权。
- 以上每种 schema 的可空字段必须明确为 null，集合用数组，不以空对象代替；正文/数组的字段进一步使用对应操作白名单。未知字段不能落入“扩展”口袋。完整工程验证器与固定向量须在开放工具前交付。

sidecar 的上述字段清单另统一包含 `revision`：不可变 lease/grant/candidate 与 lease 撤销记录固定为 1；可变 decision 从 1 开始逐次 CAS 递增。撤销记录也固定含 schemaVersion/projectId/leaseId/revision=1/at/reason/hostEpoch。operation 自有 revision 单独递增，不借用业务实体修订。UI 命令不接受模型 token：宿主为一次真实表单提交生成 actionNonce（关键决定用 decisionNonce），冻结重复点击使用同一 nonce，并以 `op_`＋SHA-256(nonce) 创建同类账本；nonce 只能在受信 UI 适配器创建，不能由普通参数伪装。租约签发、grant、采用和验收本身也要纳入此 UI 命令账本；不是先写这些资料再假装有完整恢复。

已提交 operationId 的只读查询不受运输 deadline、token/lease 过期、授权撤销、旧 hostEpoch 或面板关闭限制，只检查可信项目身份、支持的 schema 和输出边界；不得把终态或 unknown 隐藏为 expired_request。记录经合法保留期清理后才可报 operation_not_found，并明确已无法证明执行结果。相同 token 的新认领与旧结果查询是不同路由；到期拒绝执行不等于删除已发生事实。

source_busy 特指非本工作租约的冲突工作；Agent 在当前工作请求里运行工具本来就不 idle，不能把全局 `snapshot.state=working` 或工具自身计数机械当作拒绝它的条件。UI 先在空闲且已明确启动时记录待激活租约，原请求提交成功后激活；原发送 pending/unknown 则仍不可写。只有当前可信租约的工具才可在该请求 working 时进入分发器，另一个自然语言请求没有原生精确 requestId 的保证仍按 DESIGN §7.6 的单会话租约边界处理。
验证的 claimed 账本只能保存准确规格、固定 evidenceId、results 前态和容量预留，不能预先编造未知输出的 after 图像；effect_observed 到达时先原子保存真实观测，再从冻结前态计算合法 evidence/results after 图像并 CAS 写回账本，之后才发布目标。回调丢失前没落盘的观测不可由模型或人工猜测重建。记录/证据的最终编码超出已预留容量属于协议故障，停在 outcome_unknown/recovery_required 并保留已有观测，不以丢弃输出或重跑修复。


### 7.3 持久幂等账本与保留上限

`operations/<operationId>.json` 是 schema v1 的**每操作账本**，而非临时 receipt。operationId 固定为 host 对 token 原字节计算 SHA-256 后加 `op_`（67 ASCII 字节），路径不能由模型提供。首次认领在项目锁与 gate 下 create-CAS；同 token 并发创建只有一个成功，其余重读。记录保存：

- schemaVersion/projectId/requirementId/id/tokenSha256/payloadSha256/operation/requestId/leaseId/binding/expected/createdAt/updatedAt/revision/state；
- 原始有界 payload、authorizationRef/grantId、固定生成的实体 ID、before/after 图像计划、发布 cursor，以及 executor 的 effectStartedAt/effectObservation/evidenceId；
- 可重放的结构化 result/error（仍走输出脱敏），cancelRequested、人工 reconciliation。对未发生的事实保留 null，不编造退出码或人工身份。账本本地存精确命令与恢复图像，不复制聊天或环境。

before/after 图像条目为固定相对目标类型＋稳定 ID、expectedRevision、beforeSha256（不存在为 null）、afterRevision、afterSha256、合法 after JSON；哈希基于实际拟发布 UTF-8 字节，非脱敏展示值。最多 3 个业务目标、单目标 ≤256 KiB；单账本 ≤1 MiB（包含 JSON 转义后），必须在执行前计算最终最坏大小并预留后续证据/终态空间。超过预算拒绝，不截断恢复图像。lease/candidate/decision/grant 单文件 ≤32 KiB；分别最多 64/128/128/64 条（撤销文件计入对应 lease 配额的额外固定一条）。operation 最多 256 条；项目全部新 tools 文件合计 ≤32 MiB。容量在同一 gate 下检查并预约，不能只在 TS 内存计数。现有正式业务资料仍受原 Store 上限，本协议不淘汰历史验证、批准或验收。

operation committed/rejected/cancelled 后**至少保存 7 天，且不早于关联 token 失效**；清理是显式维护动作，经单写者检查引用、期限和总容量。未认领 token 的 lease 也至少保留至 token 失效；lease/grant 若被仍保留账本引用一并保留。候选、决策及采用/人工决定历史不自动淘汰；到上限拒绝新增，显式一致备份/归档方案须另行批准，不偷偷删历史。prepared/claimed/applying/effect_started/effect_observed/outcome_unknown 以及未解决的人工事项不按年龄驱逐。不能因为满了就删除最旧操作。

过期 token 永远不能发起新执行；还在保留期的终态只允许按 operationId 查询。缺 lease/token 登记报 token_invalid_or_expired，不按新请求接受。新 host 从持久 issuedAt/updatedAt 求可信时间下界；系统时钟明显回退（>5 秒）报 clock_regressed，禁止认领和基于时间的清理，要求核对系统时间，不用回退时钟延长旧授权。容量满报 ledger_capacity_exceeded，读与核对继续可用。IPC tools requests/responses 是短期运输副本，单 runtime 最多 64 对、总计 4 MiB，未认领消息最多存 30 秒，终态响应 24 小时后可显式/运行时清理；删除它们不会删除业务账本或证明执行未发生。

### 7.4 CAS、发布与崩溃恢复

所有 UI/工具领域变更进入同一 dispatcher：先确认无未核对操作，持项目 token 在 gate 下检查所有依赖 revision **及原文件字节摘要**，持久 claimed 账本（包含计划/生成 ID），再执行发布。operation 的 revision 也逐次 CAS；prepared 仅为已签发令牌尚未认领的投影。新发布器必须在各个副作用边界重新校验协议栅栏/锁与计划前态；不可把用户可编辑文件的 revision 当成防篡改证明。项目级进行中 operation 是持久互斥，不用 UI 当前 selected 作为目标；控制记录/心跳更新不与业务互斥混为一谈。

1. **纯存储命令：** claimed→applying，按固定计划逐文件 CAS，最后 committed 写结果。候选创建只写不可变 sidecar；计划更新一次 plan CAS；决策提交写 decision；采用设计仍是 immutable design→requirement 阶段→workflow，验收仍是 reviews→requirement。创建需求仍用原 staging→project 分号→目录发布，但账本固定 staging/id/number，目录发布作为对应 requirement 目标的发布步骤记录，不能重新分配编号。资源等旧入口也由同一协调器记录发布，不能保留绕账本的旧 UI 别名。
2. **验证命令：** 先冻结预执行快照、准确规格、results 前态和确定 evidenceId；在账本持久 effect_started 后才允许一次进程启动。真实回调先持久 effect_observed（退出/超时/限量 stdout/stderr 与字节数），再 evidence create-CAS→results CAS→committed。启动和 effect_started 不可能原子，崩溃在两者之间也按 unknown，不自动判断“未启动”。grant 在 effect_started 前已被该 operation 唯一认领。无观测回调不能由模型补写证据。
3. **重载/关闭/来源改变：** 自动流程只读扫描、有界核对和展示 recovery_required/outcome_unknown，不补发布、不运行命令、不恢复旧 nonce/租约。须人明确“核对并恢复记录”，重新取得新锁/可信 UI 上下文后才进行下面的存储修复；恢复执行器永不再次启动 shell/sendUserMessage。未知外部效果先核对，不把人工知悉当成终止确认。
4. **恢复判定：** 依计划顺序重读。目标是精确 after（版本、ID、字节 hash）则该步骤已落盘；仍是精确 before（或仍不存在）才允许按原 after 图像 CAS 完成**纯记录发布**；任何其他内容/revision/目录状态都报 recovery_conflict，保留原始资料与草稿，不覆盖、不删除孤立 evidence。不可变目标同 ID 异内容同样拒绝。所有 after 已存在而终态回调丢失时，只补 committed，不再触碰业务实体。
5. **部分失败：** 只有 evidence 且摘要未写时，从已校验 effect_observed/不可变 evidence 核对 ID、原命令、内容/代码身份和完整 hash，再按原 results 前态 CAS 关联；不自动合并最新 results。只有 effect_started 而没有可信 effect_observed/evidence 时维持 outcome_unknown；即使找不到 evidence 也不能重新执行。已出现 evidence 但账本不同身份时拒绝归属。设计/验收等已有多文件路径同样核对 before/after，不用当前方便的状态重造用户决定。

依赖纯读查询可返回 `consistent=false` 与所读修订集合；操作工具绝不在发现 CAS 冲突后自行重新计算新 after 图像。存储修复可恢复记录完整性，但不承诺断电时文件系统/跨 WSL 的绝对持久或网络/进程“恰好一次”。已有 §6.1 的当前恢复缺口仍然存在，直到这些新协调器/读写器实际实现和验证，不能把本文目标套到当前函数上。

### 7.5 授权、取消与未知结果

授权引用只是查找条件，可信 host 必须重新解析 lease、未撤销 approval、grant/decision 及当前内容/代码快照；工具传 `clicked=true`、SDK approval 已通过、actor=human 或 passed 都是 unknown_field/permission_denied，不创建人工身份。UI nonce 仅进程内一次性存活 5 分钟，绑定精确展示数据；最终人工验收必须重算统一 gate 并独立拒绝零条件，不能调用底层记录函数绕开门禁。

相同 token/摘要的重放优先返回现有账本状态，**不重新授权或执行**；旧 hostEpoch/租约失效时只能查询旧结果，不允许继续旧命令。仅在原来未产生账本且令牌、租约和当前门禁全部有效时才允许认领。授权撤销阻止新副作用；命令已 effect_started 则记取消/撤销事实，不能抹掉真实执行或说已经杀死进程。

认领/运输 deadline 最长 30 秒，验证执行 timeoutMs 为 1–180000，工具单次等待最多 30 秒后返回 operationId 与实际 pending 状态。未认领且到期的消息 rejected/expired_request；认领后工具 AbortSignal、调用断线、面板关闭、执行超时都不等于回滚。取消在效果尚未开始且账本明确无已发出的进程/发布时，可 CAS 为 cancelled；effect_started 后仅 cancelRequested=true，只有可信进程终止/回调证据才能报告真实退出结果。首版无已验证的 WSL 全进程树终止能力，不开放假“已停止”状态。存储发布中取消先核对已完成步骤，不能留下半发布又宣称 cancelled。

人工结束等待追加 reconciliation `{kind:user_acknowledged,note,at}`，operation.state 仍 outcome_unknown；为新请求释放互斥须另有明确风险确认记录，展示“原进程可能仍在运行”，在不能排除活动进程时仍禁止同项目新的执行。解除业务等待不自动产生新 token、批准、证据或重发。

### 7.6 有界读取与输出合同

工具载荷/响应上限、JCS 摘要与有限脱敏按 DESIGN §7.5/§7.8。只读 TS 必须实现与 Luau 同版本的字段校验、固定目录映射与无链接文件读取，不调用业务写入器；当前 handoff.ts 不能被误认作完整工具 reader。列表最多 20、正文/输出页最多 8 KiB、响应含 content/details 合计最多 32 KiB，日志/错误也不得带原始凭据。读取完整记录有现存 Store 容量上限，分页不是允许扫描无限文件的理由；tools 扫描受 §7.3 文件数/总字节限制。

先读项目/相关记录和校验身份，再在返回前复查 revision/hash；漂移即 snapshot_changed，不拼接不同版本为一致状态。游标是适配器签发的有界不透明值（≤512 字节），绑定项目/实体 ID、revision/hash、section、脱敏规则版本与位置，失效不自动跳到最新内容。模型不能用 cursor 注入文件路径。读取旧版本按真实 legacy 语义输出，不合成 contentRevision 或 native 来源；缺少当前快照时只给历史结果和 unknown 有效性，不刷新 results 冒充只读。

### 7.7 具体错误码

协议错误码固定小写 snake_case；可额外保留有界原 domainCode，不以字符串匹配人类说明。响应含 state、operationId（认领前可为 null）、result/error/observedAt；error 的 recovery 是下表固定枚举之一，current 仅给相关实体 ID/revision/安全重读引用，message ≤512 UTF-8 字节。任何错误都不授权自动重跑有副作用请求。

| code | 确定语义 | recovery |
| --- | --- | --- |
| unsupported_protocol / unsupported_operation / unsupported_activity / capability_unavailable | 两端没有共同实现或该活动未上线 | upgrade_endpoint |
| host_unavailable / source_stale / source_context_unavailable | 无可信新鲜 host/来源/SDK main 上下文；未认领 | reopen_and_rebind |
| binding_mismatch / wrong_target / lease_expired / lease_revoked | 项目、需求、会话、分支、请求或租约不符 | rebind_or_authorize |
| invalid_envelope / unknown_field / duplicate_json_key / invalid_payload / payload_too_large | 结构、字段、编码、上限非法；未执行 | correct_input |
| invalid_path / symlink_not_allowed / sensitive_content | 路径/来源/敏感内容不能安全读取 | choose_safe_reference |
| permission_denied / human_confirmation_required / approval_stale | 禁止操作、没有可信人工事件或批准失效 | request_human_decision |
| grant_required / grant_mismatch / grant_consumed | 精确执行规格未授权或已被别的操作认领 | request_human_decision |
| decision_pending / decision_rejected / decision_stale | 决策未批准、拒绝或目标已改变 | inspect_decision |
| token_invalid_or_expired / idempotency_conflict | 无有效签发记录/过期，或同键不同摘要；拒绝执行 | inspect_original_operation |
| revision_conflict / snapshot_changed / recovery_conflict | 精确 CAS、读快照或恢复图像不匹配 | reread_and_compare |
| lock_conflict / source_busy / operation_in_progress | 不是写者、有非工具工作冲突或已有未核对操作；不排队 | wait_or_reconcile |
| expired_request / cancelled_before_claim | 尚未认领已到期/取消，确认无业务副作用 | explicit_new_request |
| outcome_unknown / execution_timeout / cancel_unconfirmed | 已可能产生外部效果，超时/取消未获确认 | reconcile_no_retry |
| recovery_required / publish_failed | 已认领，部分发布或持久结果未确定，不能直接宣称失败无效 | inspect_recovery |
| ledger_capacity_exceeded / clock_regressed | 无足够持久容量/时间不可信；新效果禁止 | maintain_or_fix_clock |
| unsupported_schema / corrupt_record / protocol_fence_mismatch / upgrade_incomplete | 不支持、损坏或版本栅栏不一致；保留资料并停写 | backup_and_repair |
| operation_not_found | 没找到 operation；不证明“没执行过”，不许可自动换键 | inspect_original_operation |

已观察命令非零退出是 `committed` 的真实 failed 验证结果，不是协议传输 error；可信退出码零也只是证据 passed，不是需求完成。领域拒绝若不属上表特例归 permission_denied 并保留 domainCode，不能统一吞成成功空结果。

### 7.8 发布、旧新端与回滚矩阵

| host / 扩展 / 项目 | 允许行为 |
| --- | --- |
| 旧/旧/原 schema | 原 v1 入口不变；无新工具能力 |
| 新/旧/原 schema | 只用旧 IPC/人工工作流；无 tools ready，不发送新操作/活动 |
| 旧/新/原 schema | 新只读工具只读已支持实体；写工具 capability_unavailable；不往旧 command 塞新载荷 |
| 新/新/原 schema，未启用 | 可协商只读；所有新业务写返回 capability_unavailable，提示独立升级；不隐式迁移 |
| 新/新/project2＋lock2 | 仅双方实际声明且恢复状态清洁的能力可写；单写者/领域门禁不变 |
| 任一旧端/project2 或 lock2 | project 读或锁校验明确失败并停写；不能删除锁、降 schema 或采用新字段忽略兼容 |
| 无面板/新扩展/任意支持 schema | list/get/evidence/operation 历史严格只读；prepare_mutation 仅在仍有效 ready 下可读 token；所有新写 host_unavailable |
| 新端/未知新 schema、损坏/栅栏不符 | 支持范围内诊断/原始导出，业务写拒绝；不初始化覆盖、不假空库 |

发布顺序：先交付并验证新 Luau、TS 及内嵌 PowerShell 的全部读取器、writerProtocol2、journal plan/恢复器和旧端拒绝；工具写能力默认关闭；再在隔离副本完成旧新组合/故障矩阵；之后用户明确停写并备份，按 §7.1 启用；最后 ready 才声明新写能力。AF-12/13 未端到端就绪的具体工具不声明，不能用 UI 先删除人工入口倒逼用户迁移。纯 UI AF-04 不触发本升级。

回滚首选匹配新 reader 的“工具关闭、仍读新项目”模式，保留 project2/lock2 与所有审计。回到旧二进制须停止两端、核对未知进程和部分发布、保存升级后完整一致备份，再恢复**升级前整个 `.omp/workbench/` 一致备份＋匹配旧代码/锁协议**；这会放弃升级后的业务变化，必须明确展示，原新目录留作历史，不能混回单个 results/requirement 或改数字。代码工作树中的真实执行副作用不随业务目录恢复撤销，必须独立核对；有 unresolved effect 时不得把还原备份包装为安全重试。未验证的断电、跨 WSL 发布、恢复与回滚路径继续是发布阻塞，不以本文设计代替证据。

## 8. 变更本契约

若实现确需改变此处约束，先在 DESIGN 与 TASKS 记录具体语义、兼容影响与验证要求；不得用 UI 简化作为放松授权的理由。完整字段定义以同步维护的真实验证器为实现依据；发现差异先解释，不以文档覆盖事实。
