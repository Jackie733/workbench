# Tern 工作台重构方案：Agent 推进，用户决策

状态：当前重构设计基线。AF-01–03 已完成，AF-04 的组件层纠偏已实现；AF-11 协议设计已定稿但未实施。精确进度见 [TASKS.md](TASKS.md)，领域约束见 [DOMAIN_CONTRACT.md](DOMAIN_CONTRACT.md)。页面信息架构、跨字段焦点层与生产安装验收仍待后续任务；历史截图不代表整体发布完成。

文档分工：本文规定产品、交互、视觉和目标架构；TASKS 是唯一进度来源；DOMAIN_CONTRACT 记录不得削弱的领域约束与已记录版本基线。归档只作历史证据，不再作为并行实施计划。发现现有代码与基线冲突时先记录差异并解决，不静默放宽门禁。

## 1. 产品定位与原则

工作台不是第二个聊天客户端，也不是数据库与工具 API 的控制面板。它是当前 omp 会话旁边的任务与决策界面：用户表达目标、查看成果、处理决策；Agent 整理上下文、维护计划、执行已获授权的工作；领域层强制执行身份、授权与证据规则。

默认选择：保留现有 Tern＋Luau＋omp TypeScript 架构，不重写成独立 Web 应用，不新增模型客户端，不启动第二个 Agent，不引入协作、多 Agent 编排或新后台服务。

设计优先级：事实准确 > 行为可预测 > 内容易读 > 操作效率 > 装饰效果。

核心原则：

1. 首屏回答目标、进展、待决策、依据，不展示完整内部状态机。
2. 每个上下文最多一个视觉主操作；危险操作不成为默认主操作。
3. 导航、状态、变更、执行四类语义有不同视觉表达。
4. 查看不写业务状态，不启动模型，不产生执行副作用。
5. 减少人工准备，不削弱人工授权；不为每个机械步骤增加确认。
6. 渐进披露依据用户任务，而不是把所有字段搬进折叠面板。
7. 显示事实与来源；Agent 摘要不取代实际变更和验证证据。
8. 删除重复入口与重复解释，不保留新旧两套工作流。

## 2. 当前问题与明确删减

| 当前界面 | 重构决定 |
| --- | --- |
| 项目标题、编辑开关、刷新、模型、连接分别占行 | 一行项目上下文；连接入口展示异常；模型与绑定详情移入连接详情 |
| 十多个阶段与优先级平铺 | 单一筛选入口，打开后才显示条件；已生效条件可移除 |
| 全阶段可点击胶囊进度条 | 删除；状态用非交互文字＋图标，历史展示真实阶段变化 |
| 工作区内嵌另一份需求列表 | 删除；返回列表，或标题旁打开需求切换器 |
| 需求、方案、交付、验收及嵌套批准标签 | 收敛为概览、变更、记录；审批在当前决策区完成 |
| 每块内容都有外框和左侧彩条 | 文档区默认无卡片；只给决策、异常、弹层边界 |
| 长期可见的 UUID、哈希、修订、协议说明 | 移入对应证据的技术详情，保留复制与导出 |
| JSON 路径、计划步骤、命令输入常驻 | Agent 工具承担常规操作；手工导入、编辑和运行入口留在更多菜单 |
| 读操作也显示黑色主按钮 | 导航与查看使用文本入口；强调色只给当前主操作 |
| 未渲染的 Markdown 文档 | 使用安全的富文本呈现；不支持时提供明确全文阅读视图，不伪装已支持 |
| “需要处理 0”“暂无需求”重复占位 | 零待办区隐藏；看板保留稳定分组标题，不重复空说明 |

不是按截图简单删除功能：低频能力保留可发现入口、审计与权限边界。

## 3. 信息架构

全局只有“工作”作为默认工作入口。“活动记录”“连接与诊断”“设置”进入项目菜单，不常驻占据同级导航空间。连接异常或未知投递必须在全局明显可见，不能因菜单收纳被隐藏。

工作首页：
- 顶栏：项目切换、当前连接状态、更多。
- 标题：工作；右侧“新建需求”。
- 工具栏：搜索、筛选、视图；排序位于视图菜单。
- 需要你决定：仅存在待批准、待验收、阻塞、未知结果时显示；同一需求合并原因。
- 需求列表：默认显示活跃需求；已完成与已取消通过筛选访问，清楚显示当前筛选范围。
- 不增加永久左侧导航栏：工作台通常位于窄侧栏。

需求工作区：
- 返回、需求编号、标题、更多。
- 一句当前状态；必要时显示最新可信观测时间。
- 概览 / 变更 / 记录，只有这组标签负责内容切换。
- 概览：目标、当前决策、Agent 进展、验收条件、关联材料。
- 变更：方案文档、实际 diff、验证证据。先内容类型切换，不再套多层标签页。
- 记录：面向人的关键事件时间线；工具执行与技术详情按需查看。

不建立独立“待办数据库”：需要处理的事项从授权、请求、阻塞和验收事实派生。点开事项不会消除业务阻塞。

## 4. 首页设计

### 4.1 列表

每行包含：标题；辅助行显示编号及一句进展；末端显示状态与必要的更新时间。默认不显示标签、优先级、类型、修订、模型。紧急需求才突出优先级；其余在详情或可选列查看。

整行点击进入详情；不得让行点击批准、发送或开始执行。更多菜单是独立焦点目标，不依赖 hover 才能找到。选中态仅用于当前位置，不使用与执行按钮相同的高对比实心样式。

默认排序：活跃需求按最近更新；需要用户决策的事项在独立的小区域突出，不默默改变用户选择的排序。保留搜索、筛选、视图、滚动位置，返回时恢复。

空项目：一句“把要完成的事情交给 Agent”，提供“新建需求”。搜索无结果：显示查询与“清除筛选”。数据读取失败不是空列表，显示恢复入口。

### 4.2 筛选与看板

筛选弹层按状态、优先级、标签组织；选项数量多时可搜索。已应用条件用轻量可移除标记，未激活选项不占页面空间。

看板仅作为可选布局，使用四个展示分组：准备中、执行中、待验收、已完成。准备中映射 backlog/clarifying/designing/awaiting_approval；执行中映射 implementing/verifying；待验收对应 awaiting_acceptance；已完成对应 done。实际枚举以现有领域契约为准。分组是只读投影，不改写持久阶段。

blocked 独立显示在“受阻”区域，保留原阶段；cancelled 通过取消筛选查看；未知或旧阶段进入明确的“其他状态”，绝不丢弃。卡片显示真实子状态，因此待批准不会被误认为正在实施。

不提供拖拽改变阶段：拖拽无法表达批准、执行与验收的真实副作用。空列保留标题作为空间锚点，不逐列写“暂无需求”。窄容器切换为纵向分组列表，不把多列看板换行成两排。

## 5. 需求工作区与关键流程

### 5.1 概览

标题之后优先出现：
- 目标：可读正文，默认展示短摘要，完整目标可展开。
- 当前决策：仅有需要用户行动时出现，说明原因、影响与下一步。
- 当前进展：可信运行状态、一句活动说明；展开才看完整计划。
- 验收条件：必需与参考条件明确区分，展示未验证/通过/失败/已过期/未知。
- 材料：资源链接与方案版本，不展示路径输入表单。

正在执行时主区域显示事实，例如“正在运行类型检查”，不能仅因模型说“完成”切换为成功。计划任务数只表示计划完成量，不能称为交付完成百分比。

### 5.2 新建需求

默认字段只有目标，多行输入支持中文。标题可由 Agent 建议，但未生成时使用用户输入的可编辑短标题，不伪造业务信息。范围、验收条件和材料为可展开选项。

“创建需求”只保存需求；创建后“让 Agent 整理需求”是明确启动一次请求的按钮。首次展示将使用当前会话和哪些材料。无需人为先填完类型、优先级、标签、全部步骤。

### 5.3 方案审阅与批准

决策区展示：方案版本、拟修改范围、关键选择、风险、验证方式。完整方案和与上次批准的差异一跳可达。摘要必须关联原方案，不能隐藏未显示的变更。

“审阅方案”只打开阅读视图；阅读视图底部“批准此方案”才写入批准。批准绑定当前需求内容身份、不可变方案与基线；确认时重新校验。

批准后显示“方案已批准，尚未开始实施”，主操作变成“开始实施”。默认不把批准和执行合并。直接实施仍可从更多菜单进入，但需说明范围、理由、验收条件与授权，不能因任务小或类型是维护就自动豁免。

内容变化时展示具体失效原因与差异。例如“验收条件已修改，需重新批准”，而不是笼统的“授权无效”。旧记录无法可靠比较时明确写“无法比较旧版记录”，不能写“无变化”。

### 5.4 开始实施与验证

点击“开始实施”进入执行确认区，展示目标需求、项目与会话、授权方案、修改范围、验证范围。确认按钮明确为“开始执行”。不强迫阅读 UUID 或指纹，但可展开技术详情。

授权范围内的计划维护、上下文读取和已批准验证可由 Agent 完成，不逐步骤确认。新命令或越界操作不能依靠相似文本继承授权。没有可强制执行的批量/范围授权时，沿用现有逐项确认，不能通过 UI 隐藏门禁。

验证的结果必须来自执行器证据，不接受 Agent 直接填写 passed。保存准确命令、工作目录、退出码、时间与代码快照；执行改变输入时按现有规则失效。重跑生成新证据，不修改旧结果。

运行时区分“请求已提交”“Agent 已接收”“执行中”“执行结束”“结果待核对”；不将消息投递视为任务完成。

### 5.5 验收

满足条件时在概览出现验收决策区：目标达成情况、实际变更、必需条件覆盖、阻断发现及残余风险。“查看验收材料”打开完整材料，最终按钮为“验收通过”，另有“要求修改”。

验收必须由人触发，确认时重新计算门禁；审查零发现、命令退出码为零、Agent 完成声明均不能代替人工验收。必需条件为零时显示“未定义验收条件”，不出现绿色 0/0 通过。

已完成页面保留成果、最终证据与验收记录；“重新打开”位于更多菜单，必须说明原因，旧验收保留为历史，不作为当前完成状态。

### 5.6 异常

| 状态 | 呈现与恢复 |
| --- | --- |
| 来源断开 | 持续异常条，说明最后观测时间；允许看历史，禁止依赖新鲜绑定的执行 |
| 投递未知 | 明确“结果待核对”；提供核对入口，不提供默认重发 |
| 授权失效 | 显示改变了什么，直接进入差异审阅 |
| 验证失败 | 显示失败条件、命令和摘要；完整输出在证据详情 |
| 证据过期 | 显示过期原因；历史通过不得染成当前绿色 |
| 写入冲突 | 保留草稿，展示最新内容与差异；不静默覆盖 |
| 存储损坏/未知版本 | 明确只读错误，提供诊断/导出；不自动初始化覆盖 |
| 会话忙碌 | 保留草稿，不默认排队、不插话、不自动发送 |
| 停止请求 | 显示“正在请求停止”；只有获得真实确认才能显示已停止 |

取消需求与停止运行是不同动作。标记阻塞、取消或重开不能宣称进程被终止。有活动或待核对操作时遵守现有转换限制。

## 6. 交互语法

| 类型 | 视觉与组件 | 示例 | 约束 |
| --- | --- | --- | --- |
| 页面导航 | 原生 underline tabs，选中项底部指示线 | 概览 / 变更 / 记录 | 无单项按钮外框，不写业务状态 |
| 局部视图切换 | 一体式 segmented tabs | 列表 / 分组 | 一个共享浅色底槽；不是多个主按钮 |
| 选择输入 | select / 明确的单选多选控件 | 优先级、状态筛选 | 选择值不是提交动作；不把所有选项铺成按钮 |
| 状态 | 符号或小圆点＋文字 | 执行中、待批准 | 不可点击，无 hover/pressed/focus 假交互 |
| 分类标签 | 小号低对比容器，无操作描边 | 维护、文档 | 默认只读；可移除筛选单独提供移除目标 |
| 局部操作 | default / quiet 按钮，按任务重要性选择 | 保存、刷新、复制 | 文案说明后果；查看入口不伪装提交 |
| 决策/执行 | 当前决策区唯一高强调按钮 | 批准此方案、开始执行 | 名称明确后果，最终校验在领域层 |
| 危险管理 | 更多菜单内危险项；最终确认用 danger | 取消需求 | 危险性独立于优先级，不是“红色主流程” |

一个可交互页面最多一个高强调动作，也允许没有。进入最终确认页后，原页面的高强调动作不再同时可操作；运行中的停止入口不能因此隐藏。组件种类、动作副作用、视觉强调是三个不同维度，不能通过颜色或 variant 授权。

不使用“确定”“继续”“处理”作为关键提交文案。查看入口叫“查看方案”，最终动作叫“批准方案”；不使用“检查并批准”这样的混合语义。

禁用操作必须有就近原因，不仅降低透明度。成功反馈轻量且不抢焦点；失败和未知状态持续展示，直到事实被处理。没有真实撤销能力时不显示“撤销”。

默认保留只读安全模式，但不在顶栏长期放黑色“启用编辑”。展示低强调“只读”；首次请求变更时解释并提供启用入口；启用本身不重放原动作，不代替执行授权。

## 7. Agent 工具能力设计

以下是拟新增的逻辑接口，不是当前已经注册的工具。实施时核对安装版本的 ExtensionAPI 与真实工具注册能力。

### 7.1 能力分组

| 逻辑接口 | 用途 | 默认权限 |
| --- | --- | --- |
| workbench_list / workbench_get | 查询需求、当前授权摘要、材料与证据引用 | 当前绑定项目只读 |
| workbench_propose | 提交需求修改、方案、计划或审查候选 | 写入候选，不批准、不验收 |
| workbench_update_plan | 更新当前请求所属需求的稳定计划步骤 | 已授权请求范围内；不能修改验收标准 |
| workbench_request_decision | 创建需用户决定的结构化事项 | 只能请求决策，不能代答 |
| workbench_run_verification | 请求执行准确的验证动作 | 执行器检查范围授权；不足则请求用户决定 |
| workbench_get_evidence | 读取验证与变更证据 | 只读，输出限量与脱敏 |

不暴露给 Agent：approve、accept、伪造来源、直接设置验证通过、无条件改变生命周期、任意文件路径写业务数据库。

读取工具按摘要/正文/证据详情分层返回；稳定 ID 优先，避免每次重复传入整份历史。工具失败返回结构化原因与恢复建议，不输出大量协议说明让模型猜测。

### 7.2 权限规则

- Agent 可以直接维护明确归属的运行计划，不需要用户手动新增每一步。
- 改变目标、范围、验收条件、已批准方案时只能生成候选，用户采用后按领域规则失效旧批准。
- 审查结果默认是带来源的候选；不得伪装成已认证原生审查或人工认可。
- 用户一次授权只能覆盖可强制核验的范围，不能以任意自然语言“都允许”绕过范围检查。
- 权限决定由可信宿主/运行时产生，Agent 不能通过工具参数声明自己已经获得批准。
- 工作台门禁不是操作系统沙箱，无法阻止同一 omp 在工作台之外直接使用其他工具；界面不得声称全局只读或全面防护。

### 7.3 AF-11 设计状态与实际落点

**本节至 §7.11 是已选定、尚未实施的协议设计，不表示 AF-11 整体完成。** 本轮不注册工具、不改 IPC 或业务 schema、不启动模型。版本、持久文件及恢复的规范见 DOMAIN_CONTRACT §7.1–7.8；AF-12/13 必须先实现这些前置能力，再开放写入口。

已核对真实调用链：`omp/index.ts` 当前只注册 `/wb`，在工厂局部绑定 main/tui/session/cwd，750ms 发布观测；`runtime.ts` 是私有临时目录中的 v1 command/receipt/open ack；`handoff.ts` 只读 project/requirement/workflow/design 并冻结预览。`lib/live.luau` 校验来源、6 秒新鲜度并把 UI 命令发往 omp；业务单写者仍是持项目锁的 Luau host。`Workflow.apply`、`Results.applyPlan/addVerification/adoptCandidate`、`Review.adoptCandidate/recordAcceptance` 经 Store 单文件 CAS 发布。host 的 `handoff-approve`/`review-accept` 才有人工动作门禁；`clicked=true` 和低层 `recordAcceptance` 本身均不是授权服务。验证当前由 host 执行 `wsl.exe … bash -lc`，180 秒超时，先 evidence 后 results；既有函数没有通用事务恢复器。

选择保留这个单写者，不让 TS 工具直接写业务库，也不新增后台服务、模型客户端、隐藏队列或第二个 Agent。提取一个 Luau 领域命令分发器供 UI 和工具共同调用；它接收**由适配器构造的可信调用上下文**，执行 `Context.evaluateAction`/Validity、身份、授权、CAS、账本与发布。不是让工具模拟 UI action 字符串，也不是另写一套 TS 领域转换。旧 UI 写入口同步迁入分发器，不能只保护新工具。

### 7.4 能力协商与路由

固定新协议名 `omp-workbench.tools`、`protocolVersion=1`；它与现有 `schemaVersion=1` 的 live/IPC 是不同命名空间。不往旧 command/open ack 塞新字段。双方另在 runtime 私有目录交换 `tools/offer.json`、`tools/host.json` 与 `tools/ready.json`（schema v1），新请求走 `tools/requests/`、回复走 `tools/responses/`。这些目录仍由 Runtime 创建和校验权限；host 只处理已证明属于该面板的 runtime，不能扫描任意项目或用户目录。

offer 包含运行时身份、协议/活动/操作白名单、读写 schema 矩阵及实际上限；host 回应包含同一 offer 的 SHA-256、hostEpoch、原 openRequestId/window/sourcePane/panel、项目身份、写者协议和所选能力；runtime 最终核对原生 dock/面板绑定后发布 ready（绑定双方声明摘要）。双方各自更新单调 sequence 与时间，超过 6 秒无新鲜心跳、会话/分支/cwd/打开请求/hostEpoch 改变均撤销 ready。租约不得只凭文件 mtime 刷新；声明损坏、能力不匹配不能降级执行。

实际能力取两端交集，按操作启用，不能由软件版本号猜测支持。活动白名单预留 `clarify/design/implement/review/analyze`；首版只开放已真正接通的活动，review/analyze 必须有新 workflow 读写器、来源校验和活动门禁才声明，绝不编码成 design。不支持返回 `unsupported_activity`。

| 路径 | 面板打开且 ready | 面板关闭/旧 host/未协商 |
| --- | --- | --- |
| list/get/get_evidence 的已有持久资料 | TS 严格只读投影；读前后核对相关 revision，不采集新 Git 观察、不写 results | 同样可读**已支持 schema**；标记 `hostAvailable=false`、观测时间和非原子快照；不猜未知字段 |
| propose/update_plan/request_decision/run_verification | TS 发给唯一 host 分发器；持久认领后才回 accepted | 立即 `host_unavailable`/`capability_unavailable`，不写业务意图、不排队、不自动打开面板 |
| 查询已提交 operationId | 只读返回原账本状态/结果 | 严格只读账本查询仍可用；无账本不能拿临时 receipt 伪造结论 |

只读 TS 投影需补齐 plan/results/reviews/evidence/新 sidecar 的严格版本读取器；当前 handoff 读取器不具备这些能力。对读取期间变动最多返回 `snapshot_changed`，不循环重试；list 有稳定 ID 游标，不承诺跨页事务快照。来源项目从可信 cwd 的 canonical Git root 与 projectId 交叉确认，不接受模型提供 root、runtimeDir 或任意 evidencePath。

### 7.5 信封、绑定与摘要

工具参数只含操作必要的业务目标、expected 修订、候选/计划/验证载荷，以及可选的**引用**；禁止传 sessionId/instanceId/actor/clicked/approved/passed/任意存储路径。适配器用真实 SDK execute 的 `toolCallId`、main 会话上下文构造信封：`protocol`、`protocolVersion`、`operationId`、`toolCallId`、`operation`、`projectId`、`requirementId`（list 可空）、`expected`、`payload`、`payloadSha256`、`binding`、`issuedAt`、`deadlineAt`、`mutationToken`（仅写）、`authorizationRef`（仅需要时）。binding 是 runtime/host 注入的 instanceId/sessionId/hostEpoch/openRequestId/leaseId/requestId/branchEpoch，不是模型的自述。信封、载荷和响应按操作递归字段白名单校验，拒绝重复 JSON key、未知字段、非 UTF-8、非有限数、非安全整数和控制字符。

requestId 指工作台已获明确启动许可的工作请求，operationId 指一次工具变更，两者不同于 toolCallId。只读工具可以按稳定 ID 查看同项目其他需求；写工具只能作用于可信租约所属需求和请求。当前原生 todo 与 assistant 文字没有该归属，仍保留 attribution=null。

写键选择 host 在人工创建租约时一次签发并持久登记的随机 mutationToken（256 bit、24 小时有效，每租约共 64 个，按四种写工具各 16 个）；经只读 get 的 `purpose=prepare_mutation` 读取该操作尚未使用的令牌，不额外写库、不授权执行、不启动模型。租约过期先于 token 时仍拒绝新执行，配额用尽须人工重新授权租约。令牌绑定项目/需求/租约、允许操作与签发时限，不预绑定载荷；首次合法提交原子认领 payloadSha256。模型可以持有/引用令牌，不能创建有效登记或获得额外权限。同 token 同摘要返回原 operationId/状态/结果；异摘要 `idempotency_conflict`；已过期 token 不执行，即使旧记录已被清理。超时后通过 `get(operationId=…)` 核对，不换键重发。

载荷摘要固定为 SHA-256（小写 hex），输入是 UTF-8 的 RFC 8785/JCS 规范 JSON：`{protocolVersion,operation,projectId,requirementId,expected,payload,authorizationRef,leaseId,requestId}`，所有列出字段必有，缺省引用为 null。对象键按 JCS 排序，数组保留顺序，字符串不 trim、不改换行、不做 Unicode 归一；禁止孤立 surrogate，v1 数字仅安全整数；集合型 ID 数组先校验唯一，再按契约字节序排序。排除 toolCallId、operationId、传输时间、心跳、令牌和摘要自身，所以同一意图的查询/重传不改变摘要；换 expected、命令、目录、条件、授权或租约均改变摘要。TS 与 Luau/PowerShell 必须共用跨语言固定向量，不能直接对各自默认 JSON 编码做哈希。现有 `requirementContent` 顺序数组哈希、候选原文件字节指纹及 handoff 文本摘要保持各自旧契约，不混用。

### 7.6 可信授权与人工决策

租约只由真实工作台“开始执行/授权此请求使用工具”的最终人工动作创建，展示项目、需求、会话、活动、期限和能力；`enable-edit`、SDK approval read/write/exec、模型文字或 tool 参数都不创建租约。租约最长 30 分钟，绑定当时内容身份、方案/直接授权、instance/session/branchEpoch、hostEpoch 和 requestId；不跨重载、分支切换或来源重开续租。发送未确认、来源存在非本请求的冲突工作或请求结果未知时不激活工具租约；本请求执行工具时的 working 不作为自我拒绝条件。SDK 目前没有已证实的业务 requestId 原生传播，因此明确采用**人工绑定的单会话工作租约**，而不声称能区分同一会话每条自然语言消息的作者意图；面板持续显示当前唯一归属，换工作前结束旧租约。

分发器每次重新读取当前内容、授权撤销、租约、快照及实体修订。计划维护只在租约能力内；改变目标/范围/验收条件/方案只生成候选，由人采用，按现有内容身份规则使旧授权失效。候选 source 由 host 写 `agent_candidate`，采用审查仍为 external，不升级为认证 native_review；任何候选来源、发现、摘要都不能授予权限。

人工决定上下文仅由宿主受信 UI 事件生成，一次性 decisionNonce 在内存绑定展示过的动作、精确目标、内容/方案/快照与有效期（5 分钟），提交时重验并消费。它不进入模型工具 schema；重载失效。批准、采用、验收和豁免分别是不同动作，不能拿“批准方案”同时批准任意验证。零验收条件拒绝人工验收；`Review.recordAcceptance` 的低层记录函数必须被共同分发器包住，不能直接暴露。

验证采取最保守的**精确单次命令授权**，不做 shell 文本前缀/正则/自然语言范围授权。人确认 command 原始字节、可信 cwd、criterionIds、timeoutMs（1–180000）、内容身份、当前代码快照与工作请求后，host 保存 grant；grant ID 不是 bearer 权限，仍须匹配租约和当前门禁。首个 operation 原子认领 grant，重放同 operation 只查结果；任何不同命令/目录/条件/超时/快照、新 operation 复用都拒绝。执行中预期代码变化不复活授权或复用证据；执行后另采集快照判断现有证据有效性。无 grant 只创建精确验证决策事项，返回 waiting_decision；批准也不自动启动命令，Agent 必须显式重新请求并引用 decisionId（新的执行 token），或用户在执行确认页点击开始。

### 7.7 幂等、CAS 与恢复体验

命令状态：`prepared → claimed → applying → committed`；无副作用拒绝为 `rejected`；认领前取消为 `cancelled`；无法证明副作用结果为 `outcome_unknown`，不能包装成 rejected。验证在 claimed 后先持久 `effect_started` 再启动进程，收到真实回调后保存 `effect_observed` 和证据，再 committed。waiting_decision 是已提交决策事项的业务状态，不是运行命令。生命周期、工作请求、工具 operation 与决策状态分开呈现。

账本/目标不是跨文件原子事务；必须按 DOMAIN_CONTRACT §7.4 的 before/after 图像和发布步骤核对。回调丢失只重读，不重新运行；恢复写必须是人工“核对并恢复记录”动作，重载只呈现 recovery_required。结果不确定会阻塞新写和不安全生命周期转换，不使用超时淘汰它。同文件 revision 相同但内容摘要不同也视为外部冲突。CAS 返回冲突实体、expected/currentRevision 与重读引用，保留草稿，不隐式 rebase 或覆盖。

取消的第一个可靠边界是认领前；进入 effect_started 后仅显示 cancel_requested，不承诺杀死 shell/子进程。现有 Tern process 未证明可确认终止整棵 WSL 进程树，首版不宣称该能力，超时或失联保留 outcome_unknown；已观察到退出码的命令即使之前请求取消仍保存真实结果。180 秒执行期限与 30 秒认领/通信期限分开；工具等待最多 30 秒，返回 operationId/pending，不代表取消执行。面板关闭立即撤销新写能力；已启动命令可能继续，未知结果不能自动续跑。人工结束等待只记录知悉，不把 unknown 改成 passed、failed 或 cancelled。

运输 deadline、token 或租约到期只禁止新认领/新执行，不妨碍按 operationId 只读查询已提交的终态、pending 或 unknown；面板关闭与授权撤销也不能隐藏已发生事实。账本合法过保留期清理后才报 operation_not_found，仍不许可自动重跑。

### 7.8 有界输入与有限脱敏

新信封 ≤32 KiB，payload ≤16 KiB，响应（含结构化 details）≤32 KiB；JSON 深度 ≤12、单对象 ≤64 字段、ID ≤96 ASCII token 字节、路径 ≤2048 UTF-8 字节。候选正文 ≤16 KiB；计划 ≤40 步，每步标题 ≤500 字节，条件/文件各 ≤32；审查 ≤50 findings、描述 ≤4000 字节，同时受总载荷限制，超限拒绝不静默截断候选。list 一页 ≤20 条；详情文本/输出一页 ≤8 KiB。证据引用使用稳定 ID，host 解析到已验证项目内固定目录，拒绝 symlink/reparse、逃逸、设备/FIFO 和未知 schema。

输出默认只有允许字段、摘要与证据 ID；不复制聊天、工具原参数/完整输出、环境变量、凭据、绝对用户路径或堆栈。正文/diff/输出仅按明确 detail 请求分页返回，按需裁剪并给 `truncated/omittedBytes/nextCursor/redacted`。先对受限源记录完成校验和原始身份核对，再脱敏，再按 UTF-8 边界分页；游标绑定源 ID/revision/hash 与脱敏规则版本，源改变报 snapshot_changed。v1 规则移除 ANSI/终端控制、掩盖 PEM 私钥块、URL userinfo/敏感 query、Bearer 与常见 token/password/secret/API-key 赋值；相对路径可以返回，home/root 前缀用展示占位符。准确命令在本地人工授权视图仍显示原文，模型输出可遮蔽敏感片段，不输出被遮蔽值的单独哈希。脱敏只降低风险，**不能保证发现所有秘密**；疑似密钥资料默认拒绝模型正文读取，本地原证据不被脱敏改写。工具 content 与 details 使用同一处理器，错误、审计导出与日志也不能绕过；本地账本不是防篡改日志或 OS 沙箱。

### 7.9 AF-12/13 固定接口

固定注册名就是 §7.1 的七个 `workbench_*` 名称，不另保留别名；approval 元数据 read/write/exec 只反映 SDK 工具级风险，不替代领域权限。

| 所属 | 工具参数与结果边界 |
| --- | --- |
| AF-12 `workbench_list` | filter/cursor/limit；只读需求摘要与下一页，不写当前选择 |
| AF-12 `workbench_get` | requirementId、section（summary/body/plan/decisions/operation）、cursor；operation 查询用 operationId；purpose=prepare_mutation 只读取人工租约预先签发的特定操作 token |
| AF-12 `workbench_propose` | token、expected、kind=requirement/design/plan/review、完整候选；返回 candidateId/源身份/待采用，不自动写正式需求、方案、审查或批准 |
| AF-12 `workbench_update_plan` | token、expected requirement/plan revision、一次 add/update_status/update_links；新 stepId 由 host 分配并在原操作结果重放，现有稳定 ID 不重建；不支持任意替换计划、验收条件或 evidenceIds |
| AF-12 `workbench_request_decision` | token、expected、kind=adopt_candidate/verification、candidateId 或准确验证规格、理由；返回 decisionId/state，不能要求工具代为 approve/accept/dispose |
| AF-12 `workbench_get_evidence` | requirementId、evidenceId、section、cursor；只读已存在证据，不执行验证、不采集新快照 |
| AF-13 `workbench_run_verification` | token、expected requirement/results revision、准确 command/criterionIds/timeoutMs、grantRef 或 decisionId；cwd 从可信项目根派生；结果仅为 operationId/state/evidenceId，passed 只来自真实执行器 |

提取后的命令分发器接口是 `execute(trustedContext, command)` 与只读 `query(queryContext, query)`：trustedContext 由 UI 或已校验桥接适配器分别构造，包含 origin、租约和真实人工事件（只在 UI）；command 是严格操作枚举而非函数名/路径。工具 proposal/decision sidecar 也走此分发器。UI 采用候选时重读原候选与当前版本，并复用 `Candidates.current`、Workflow/Results/Review 校验；plan/review 外部 JSON v1 继续读，不把模型载荷强行伪装成文件。AF-12 必须补齐 sidecar 读取、正式采用路径与稳定 ID 结果核对；AF-13 补齐 nonce/grant、执行认领、证据恢复及 UI 返回原 decisionId/requestId。等待决策不自动发模型消息；以工具查询或用户明确继续恢复原闭环，拒绝隐藏 steer。

### 7.10 错误与兼容

统一响应是 `{protocolVersion,operationId,state,result,error,observedAt}`，缺省 result/error 为 null；error 为 `{code,message,domainCode,recovery,current}`，message 为有界脱敏人类说明，程序按 code 处理。错误码、恢复建议与矩阵固定在 DOMAIN_CONTRACT §7.7–7.8。不把“accepted/submitted”叫交付完成，不把进程退出叫人工验收。未知状态/协议必须拒绝，不能作为成功空结果。

新旧端只在原 v1 能力内交互；新工具不通过旧 IPC 发送。启用新持久协议是**独立、明确的项目升级决定**，不是安装 UI 或读工具的副作用；在读写器、旧端隔离与恢复验证全部就绪前，项目保持当前 schema。关闭面板仍保留旧只读查看/人工导入入口；新工具尚未等价接通前不移除外部 JSON 导入。回滚必须停写并恢复一致目录备份及匹配代码，不能删除 tools 目录后让旧端继续处理已产生副作用的业务状态。

### 7.11 实施退出条件

AF-11 余项是实现并验证协商/信封/严格读取器、统一领域命令入口、schema 双栅栏、账本 CAS/容量/恢复和错误路由；设计文本不替代它们。AF-12/13 必须覆盖同键异载荷、旧新端、关面板、主会话/子会话、换分支/项目/需求、模型自授身份、授权撤销、CAS 与相同修订异内容、发布任一步回调丢失、命令已启动但无回调、未知结果不重跑、容量满和回滚。验证使用隔离项目与真实工具分发；本次设计工作未运行测试、构建、格式化或模型。

## 8. 设计系统：原生语义优先，而不是统一圆角盒子

### 8.1 官方依据与取舍

本轮实际阅读了 Tern 的 Architecture、Designing Views（含 Deploys 模板图与 Luau 配方）、Styling Views、tabs/badge 契约，Ant Design Button/Tabs/Tag/Customize Theme，以及浏览器渲染后的 Material Design 3 Design tokens / All buttons。Material 页面静态读取只有壳，研究结论来自加载后的正文，不以搜索摘要代替阅读。

| 依据 | 采用 | 不照搬 |
| --- | --- | --- |
| [Tern Architecture](https://docs.stencil.so/tern/concepts/architecture.html) | host 持有块与业务状态；window 负责局部 UI/CSS；manifest styles 可随 catalog 到远端/Web | 不把主题设计变成跨 VM 状态服务；不靠 window-only CSS 支撑核心语义 |
| [Tern Designing Views 与 Deploys 模板](https://docs.stencil.so/tern/print.html#designing-views) | 原生 kind 优先；一页一个主要动作；underline / segmented 各司其职；少卡片、两档密度、状态局部着色 | 不照搬部署仪表盘的 stats 或双栏；需求工作台无必要数据就不显示 |
| [Tern Styling Views](https://docs.stencil.so/tern/print.html#styling-views) | CSS last，工作台作用域，稳定 role 钩子；内部 class 与支持能力按安装版本核对 | 不把浏览器 CSS 支持当成 Tern 支持，不重写所有原生组件几何 |
| [Material Design tokens](https://m3.material.io/foundations/design-tokens/overview) | reference → system → component；按用途命名，按上下文切换值 | 不引入 Material Web、FAB、全胶囊、大阴影或为所有细节建立生成器 |
| [Material All buttons](https://m3.material.io/components/all-buttons) | 高/中/低强调与位置共同建立层级；一个 prominent action | 不为了填满层级而常驻所有按钮类型 |
| [Ant Button](https://ant.design/components/button/)、[Tabs](https://ant.design/components/tabs/)、[Tag](https://ant.design/components/tag/)、[主题](https://ant.design/docs/react/customize-theme/) | 主次动作、危险/禁用/忙碌独立；导航/分类分开；组件 Token 独立覆盖 | 不引入 React/Ant 运行时，不照搬后台管理模板的密集表单 |

**选择一种语言：Tern-native 的安静桌面工具。** Material/Ant 提供设计方法，不提供第二套视觉皮肤。宿主决定主题色；工作台负责语义、层级、留白、信息结构。不是永久强制蓝色，更不能因为颜色相同就让所有组件形状相同。

### 8.2 当前实现差异与纠偏边界

用户报告“按钮、tab、tag 相似，功能与优先级不清楚”是本轮问题证据，不需要重跑截图来确认。

| 实际代码 | 造成的问题 | 替换方向 |
| --- | --- | --- |
| `styles.css` `.sf-tab` 使用 control border、圆角、独立 surface | 页面导航变成一排描边按钮；还覆盖 segmented 的差异 | 恢复原生 underline；segmented 单独保留原生整体底槽 |
| `.sf-badge` 使用 control border、24px 高、胶囊与统一内边距 | 只读信息借用了可操作控件的边界强度 | 状态优先符号＋文字；分类 tag 才有轻量容器，不继承操作描边 |
| `Context.choices`、`stepper` 使用 `button`/`.on` | 表单选择、流程、页面导航都借用了按钮语法 | choices 按场景换 select/segmented；阶段按钮导航按 AF-06 删除 |
| 全局 button min-height 34、统一描边；quiet 也普遍强调色 | 工具栏、表格、表单密度相同；次级操作争夺注意力 | 保留原生 sm/md，按组件与区域决定强调 |
| 调用点自行传 variant；动作类别只做局部降级 | 没有全页主动作仲裁，风险与重要性混在一起 | 页读模型选 primaryAction；动作同时声明 kind/emphasis/risk |

纠偏已按此契约落地（记录见 TASKS AF-04）：Token 分层、原生 Tabs/Segmented、Status/Tag/Button 分离、页级主动作仲裁与消费端回归均已接通；后续页面只消费这些组件，不再各自拼装按钮与选择控件。旧首轮截图保留为历史证据。

### 8.3 Token 分层与唯一来源

沿用 `styles.css` 为最终样式值来源；不新增平行 JSON、生成器、主题服务或第二套组件库。下列是目标命名，不是已存在的 SDK 属性或已实现的变量。

1. **Reference（`--wb-ref-*`）**：少量固定尺度。space=4/8/12/16/24/32；radius=0/4/6/8；stroke=1/2；reading-body=14/22。只有主题适配层可定义必要的后备色，不让页面各自写 hex。
2. **System（`--wb-sys-*`）**：主题角色与成对前景/背景。宿主变量 → 工作台语义；浅/深/自定义主题在此映射，不在每个组件重算颜色。
3. **Component（`--wb-comp-*`）**：只为需要独立调节的部件建别名，例如 button-primary-bg、tabs-indicator、status-text。引用 system/reference，不直接引用另一个组件的私有 Token。

| System 角色 | 宿主适配依据 | 用途与禁止事项 |
| --- | --- | --- |
| canvas / surface / surface-raised | `--bg` / `--card` 与实际 elevated surface | 页面、局部对象、弹层；不为每段正文加 surface |
| text / text-secondary | `--t1` / `--t3`，按实测修正 | 正文、辅助文字；权限与失败原因不使用极淡字 |
| action-container / on-action | `--accent-fill` 与原生 primary 的配对文字色 | 成对校验主按钮；不能把任意 accent-ink 当填充色，不能一律假定白字 |
| link / focus / selected-indicator | `--accent-ink` / `--accent` 的对应用途 | 链接、焦点、导航指示；与主按钮背景分别命名 |
| selected-container / selected-text | 原生局部选择的配对主题值 | 分段/行选择；不是主动作 |
| divider / outline-control | `--l1`/`--l2` 与必要交互边界 | 装饰分隔和控件边界分开，不能把 control border 套给状态/tag |
| success / pending / warning / danger | 对应原生 tone 及配对低强调背景 | 可信证据、待决策、风险、失败；不是分类标签的装饰调色板 |

宿主变量的名称不是对比度保证。采用原生 primary 的完整配色而非只抽取一个变量；不满足对比度时在工作台适配层调整整对值，并验证主题切换。主题允许改变色相，不改变“下划线导航、只读状态、实心主要动作”的语法。默认不再将宿主 teal 判作错误配色。

对比度：普通文本 ≥4.5:1；必要的边界/焦点 ≥3:1；大字按对应标准。非交互状态不要求为了满足“控件边界”额外画深色外框，其文本和有意义图标仍须合格。旧版的 58% 混色只是特定主题实测修正，不提升为所有组件的通用设计规则。

### 8.4 组件必须有不同的轮廓与行为

| 组件 | 默认形态 | 当前/选中 | 可否执行业务动作 |
| --- | --- | --- | --- |
| 页面 Tabs | 文字＋一条整体分隔线；每项无填充、无外框、无圆角块 | 2px 底部指示线＋字重，不加独立按钮框 | 否；只换当前内容 |
| Segmented | 2–3 个短选项共用一个浅底槽 | 当前项为中性 surface，与强调主按钮不同 | 否；只切当前视图/局部筛选 |
| Status | 小符号/圆点＋状态文字；无包围边框 | 不存在 selected；未知/过期/失败用明确词语 | 否；无 actions、hover、focus、手形假象 |
| Tag | 18–20px 内容高度，4px 圆角、轻中性背景、无操作描边 | 分类 tag 没有 selected | 默认否；筛选移除必须有独立、具名的点击目标 |
| Primary button | 强调色实心＋配对文字，6px 圆角 | hover/pressed 不改变尺寸；提交时 busy | 是；全页至多一个，名称说明实际后果 |
| Secondary button | 中性控件轮廓或原生 default | hover 局部反馈，不持久 selected | 是；保存替代、重试等支持动作 |
| Quiet button | 默认无背景/边框，中性文字；hover 才出现轻背景 | 一般无持久 selected | 是；刷新、复制、展开、返回等，不能伪装成静态文字 |
| Content link | 语义链接色，必要时下划线/方向提示 | 无按钮 selected | 只打开内容或外部链接；标明目标，不充当提交 |
| Destructive action | 平时菜单中的危险文字；独立确认区才用 danger 按钮 | 不成为页面默认选中项 | 是；领域门禁不因红色样式而省略 |

形状与位置先表达组件职责，颜色再表达状态。**灰度下仍须区分 Tabs、Tag、Status、Button。** 不给静态标签添加 32px 按钮高度，也不使用“✓ 已选择”把每个视图切换伪装成流程完成。

Tern 的原生 `tabs` 已有 `variant="underline"|"segmented"` 与 `select` 事件；原生 badge 默认胶囊且不换行，不能假定它同时满足状态文本与可移除 tag 的全部需求。Status 优先 text/span 的真实 tone；确需独立形态时才用 scoped role。不要给 badge 临时塞入伪造 SDK 属性。

原生 underline tabs 超宽会裁切，不会自动滚动；三项短页签应在 360px 下适配，额外选项进入视图菜单，而不是强行换行成多排标签。键盘切页只在导航焦点范围内处理，不照搬模板全局 Tab 切页而截获输入字段的焦点移动。

### 8.5 按钮的功能、优先级和风险分别决定

动作契约保留 `kind=navigate/read/edit/decide/execute`；视图另外声明 `emphasis=primary/secondary/tertiary`、`risk=normal/destructive`。这是目标视图元数据，不新增业务持久字段，不改权限协议。

- **kind** 决定行为与文案；**emphasis** 决定注意力；**risk** 决定危险呈现。不能由按钮文案正则或生命周期颜色猜测，更不能“一切写操作都 primary”。
- 一个页面读模型返回唯一 `primaryAction`（可空）和可用原因；其余调用点不能自行升级 variant。不同页面分别挑选，不按屏幕上每个 card 都分配一个。
- 创建页主动作“创建需求”仅保存；编辑页“保存修改”可以是主动作；审阅页“批准此方案”才写授权；开始页“开始执行”才启动；这些都是不同提交，不能合并成“检查并批准”。
- “查看方案”“返回工作”“复制编号”通常是链接/quiet；“刷新”“重新读取”可为 default/quiet。读取如果采集文件并写快照，不能假称纯查看。
- 没有可执行主要动作时允许没有实心按钮，不能把危险操作或无关操作升级来填空。相关门禁原因放在决策区，不平铺十几个禁用按钮。
- 危险入口与确认分开。确认区保留醒目的退出动作，最终 danger 名称写清“取消需求”；正常“返回”不能染红。停止运行必须可见，但只有真实执行状态支持时才显示有效操作。
- `disabled` 保留就近原因；`busy` 保持宽度、防重复触发并反映真实请求状态。`selected` 是导航/选择状态，不是 busy、批准或完成；`:active` 只表示短暂按下。

组件状态表统一覆盖 enabled / hover / pressed / focused / disabled / busy；后两者禁止派发，但不能抹淡失败原因。Status/Tag 不参与按钮状态表。焦点环独立于 selected underline，不因已经选中就隐藏键盘焦点。

### 8.6 排版、密度与布局

方向从“大面积 34px 描边组件”回归 Tern 的两档密度；阅读正文保持中文可读，不对全部节点设同一字体/行高。

| 场景 | 目标 | 取舍 |
| --- | --- | --- |
| 页面标题 / 区块标题 | 18/26、15/22，600 | 一页一个标题；文档正文内用标题层级，不每张卡重复 title |
| 中文阅读 / 表单正文 | 14/22，400 | 约 66ch 阅读宽度，不能限制 diff/table 的必要宽度 |
| 工具栏 / 操作文字 | 宿主 13px；md 约28px | 主要提交可32px；不将所有按钮最小高度抬至34 |
| 内容行内操作 | 原生 sm 约22px | 实际指针目标满足至少24px或合规间隔；无法证明时增至32px，不凭视觉高度宣称合格 |
| 辅助信息 / 代码 | 12–13px；代码等宽 | 权限、错误与决策说明仍用正文尺度 |
| 触控 | 实际目标至少44px | 独立密度上下文，不全局放大桌面标签 |

组件 gap 优先用原生 `xs/sm/md/lg`（当前文档为2/6/10/16px）；页面 section 使用16/24px节奏。不把 reference 的4px尺度机械替换每个原生 gap。页边距16px，窄面板12px；文档块无描边，只有输入、决策、异常和浮层需要明确边界。列表用对齐、行分隔和轻 hover，不给每行再套一张卡片。

不为形状多样性增加无意义圆角：underline tabs 为0，tag 为4，按钮/输入约6，对象/弹层约8（原生可保留其合理默认）。默认无阴影，浮层才允许轻 elevation。图标遵循宿主风格，16px为主；不以 emoji 的渲染差异代替正式图标。

### 8.7 页面配方与实施顺序

**首页：** 一行项目上下文 → “工作”标题＋唯一创建入口 → 搜索、筛选、视图 → 有需要才出现的决策摘要 → 平面需求列表。没有数据就不显示 stats；状态词在行尾，普通优先级不做 tag。

**工作区：** 返回＋编号/标题＋更多 → 一句状态 → 三项 underline tabs → 当前内容。概览的决策区承载唯一主要动作；状态、计划和文档没有各自的 primary。变更页的“方案 / 实际变更 / 验证”使用局部视图菜单或 segmented，不再增加一排同级 underline tabs。

**最终确认：** 替换阅读页，内容在先、影响与范围其次、底部一组提交/返回；不让底层主按钮继续可操作。保持 AF-02 的焦点与模态限制，不假装 overlay 自动 inert。

执行顺序固定为：AF-04 先交付真实组件对照表面与统一动作强调契约 → AF-05/06 移除旧按钮导航和手工选择墙 → AF-07–10 接入各流程。每步删除被替代样式，不在旧强覆盖后追加另一套“临时更高优先级”。

### 8.8 视觉验收不是只数对比度

AF-04 重新关闭必须同时具备：

1. 同一原生 surface 展示 Tabs、Segmented、Status、Tag、三级按钮及危险确认；标签用真实消费者场景，不把所有样例拉成满宽按钮。
2. 浅/深/自定义主题与灰度对照，能从轮廓、位置、指示线区分组件；完整显示 enabled/hover/pressed/focus/disabled/busy。灰度对照是设计证据，不代替真人可用性测试。
3. 页面级 fixture 验证最多一个 primary、纯状态不能点击/聚焦、切页/选择不提交、最终提交才有写入/执行；测试消费者行为，不锁定文案或源文本。
4. 360/492/800/1100 CSS px 实际 surface，页签不裁切、主动作与原因可达、表格/diff局部滚动；不按整窗宽度或 `cx.cols` 冒充。
5. 实测文本/必要边界/焦点对比度，记录样本范围；实际焦点与 IME 路径交由生产适配验证，不能拿 gallery 自己的事件适配冒充生产已支持。

正式可用性仍遵循 §12 的陌生用户任务观察。AF-04 本轮交付覆盖组件层、真实主题/状态/灰度/窄宽证据与消费者契约；页面信息架构与旧页头/筛选行仍由 AF-05/06 完成，生产跨字段焦点层仍归 AF-06/15，不能用 gallery 的焦点演示代替。

## 9. 响应式与桌面输入

断点依据工作台容器宽度，而不是整台显示器：
- 小于 520px：单栏；标题允许换行；次要操作进入更多；详情以替换主内容的阅读页展示，不再挤出侧抽屉。
- 520–899px：单栏宽内容，可使用浮层筛选；审批仍保持一个阅读流。
- 900px 及以上：仅在需要对照时使用正文＋约 280px 证据栏；不默认增加仪表盘。

只允许一条轻量吸顶上下文栏，不叠加吸顶标题、进度条、统计与操作条。长方案的批准区可在阅读视图底部固定，但不得遮挡正文或与顶栏同时争抢空间。

最低验收宽度 360px，兼测 492、800、1100px 和系统缩放。diff 的横向滚动限制在代码区域，不允许整页横向溢出。

键盘：原生 Tab 顺序跟随视觉顺序；Escape 关闭顶层临时界面并恢复焦点；编辑器 Enter 换行，绝不借主按钮默认提交批准或执行。中文 IME 组合期间不触发快捷键。切换需求时草稿按项目/需求/动作隔离，提交成功清理该动作草稿，失败保留。外部事件不得重建正在输入的编辑器。

宿主能力必须按当前观测判断，不能将历史“没有 a11y 节点”的记录当成所有新 surface 的结论。AF-02 在隔离 Tern 0.9.18 真窗口观察到 Dialog/Heading/TextInput/Button/ComboBox 节点和禁用原因，并完成了跨字段 Tab、modal 焦点闭环与组合撤销分组矩阵（见 §9.1）：原生不提供跨字段自动 Tab 遍历、button 获得 `frame focus` 时不显示 `.focused` 且不自动以 Enter/Space 触发 `action`、打开 `modal=true` overlay 时背景 `.sf-main` 节点仍留在 `a11y` 树中（未自动 inert）。因此关键决定默认采用**替换阅读页**彻底规避假模态背景泄露；必要的轻量弹层与表单由宿主显式维护焦点环/顺序、`Enter`/`Space` 按钮激活、Escape 回焦与 60ms 输入突发撤销分组，并在 AF-15 做整页与辅助技术实测。

### 9.1 AF-02 已观测能力与未决边界

- 环境：WSL Bun 1.3.14、Lune 0.11.1、omp 18.20.0；Windows Tern 0.9.18（6f1fa0f），插件 3.7.1。LSP 返回本项目无配置服务器；没有据此推断代码无诊断。
- `.path` 探针插件仅安装在 `target/af-baseline/native-config/plugins`，同时隔离 TERN_CONFIG_DIR 与 TERN_DAEMON_SOCKET；只改配置目录不足以隔离默认 daemon 的插件清单。真实窗口使用独立 control 57994，未操作日常 pane、需求或会话。
- 离屏 shot 未加载探针 host，显式 new_block 断言失败；不得将空白图算支持。改用独立真实窗口后，原生 Markdown 标题/列表/代码/链接、select 弹层、modal overlay、长内容滚动和 `cx:frame` 关闭恢复编辑器焦点均有观察证据。链接仅验证呈现，未打开外网。
- 原生 API 的 `cx.cols/rows` 是字符单位，不是 CSS 像素。整窗 resize 360 被系统最小宽度夹到 720；通过真实分栏得到 371px surface、339px 编辑器，布局可用。这不是严格 360/492/800/1100 全矩阵验收；实现按单栏保守布局，不按 cols 冒充精确像素断点。
- commit/type 按 [原生输入契约](https://docs.stencil.so/tern/elements/input.md) 通过 key 事件进入，不由 Tern 自动编辑正文。最初探针没有回应 focus 事件，导致 preedit 不显示；补充 `cx:frame({{"focus",ev.id}})` 后，真窗口观察到 `.sf-ed-preedit` 的“智能”和“组合”。F6 先安排 300ms 重绘，再进入组合输入，500ms 后组合 span 仍存在且 refresh=1，提交后持久文本为“初始保留”。
- 组合撤销分组、跨字段 Tab 与 modal 焦点闭环矩阵（`tests/native-capabilities/host.luau` matrix 模式，控制端口 `0` 隔离窗口）：
  - **组合撤销分组（grouped-undo）：** `commit "工作台"` 以约 13–15ms 间隔的单个 `key` 事件到达；在宿主缓冲层基于 `tern.now()` 实施 ≤60ms 单次非换行插字突发合并后，`Ctrl+z`（以 `meta=true` 或 `ctrl=true` 到达）单次将 `"工作台"` 整组撤销回 `"初始"`；间隔 120ms 后的独立输入 `"AB"` 与提交 `"新"` 在 `Ctrl+z` 后仅撤销 `"新"`，保留 `"初始AB"`（`native-matrix-grouped-undo.json` / `.log`）。生产 `host.luau` 尚未接入该突发合并，须在工作台编辑器辅助层落地。
  - **跨字段 Tab 与按钮/Select 限制（native-tab vs host-tab）：** `native-tab` 下 `key` 对 `tab` 返回 `false` 时，原生不移动焦点，输入 `"B"` 与 modal 内 `"M2"` 仍停留在原控件（`native-matrix-native-tab.json`）。改由宿主维护可见焦点顺序表并调用 `cx:frame({{"focus", nextId}})` 后，`host-tab` 验证输入可从 `input`(`main.title`="标题1") 切换至 `editor`(`main.draft`="初始2")，`open` 后进入 `layer.dialog.modalNote`（"X"），连续三次 `Tab` 在 `modalNote → modalConfirm → close → modalNote` 闭环不穿出底层（"Y" 写入 `modalNote="XY"`），`Escape` 恢复原焦点 `main.open`（`native-matrix-host-tab.json`）。但同时观测到两项原生限制：`cx:frame` 聚焦 `button` 时不加 `.focused` 类且按键 `Enter`/`Space` 不原生触发 `action`；因此宿主需自绘非文本控件焦点态并处理 `Enter`/`Space` 激活。
  - **modal a11y 边界：** `overlay({modal=true})` 在 `a11y` 中呈现 `role="Dialog"`（`states=["modal"]`），输入光标由隐藏代理 `MultilineTextInput`（`Terminal input`）跟随；但背景 `.sf-main` 节点仍留在 `a11y` 树中未被原生置为 inert（`native-matrix-a11y-modal.json`）。基于该真实 AT 限制，关键流程坚持默认替换阅读页，仅对非关键轻量确认使用 overlay。
- 最初 `appearance dark`/`theme titanium` 未变色的原因是隔离配置 `theme="Light"` 固定了外观。通过 Settings API 读取真实枚举，再只在隔离配置设置 Dark 后，真窗口和 surface 均切成深色（`dark-confirmed.png`）。自定义主题与对比度全矩阵仍由 AF-04/15 验证。禁用按钮无 forbidden 事件，a11y description 有原因。
- 离线 SDK 探针：隔离无凭据 RPC 进程显式选择模型名称后可注册工具，getAllTools/getActiveTools 可见，session_start 有 main/rpc/hasUI=false、sessionId/cwd；此模式不调用模型，不证明真实 execute 调度。
- 另执行一次独立 `/tmp/af-sdk-*` 项目中的真实单回合工具探针：限定 af_capability_probe、无会话保存、不加载项目上下文/扩展/规则，无业务面板。真实 native dispatch 收到 toolCallId、main/print 上下文、独立 sessionId/cwd，providerRequests=1，execute 期间 addAdditionalContext 存在。此回合读取正常配置中的既有提供方凭据但未复制凭据、改默认模型或向日常会话发送请求。`sdk-dispatch-report.json` 为真实分发证据，不再拿直接调用 handler 代替。
- 固定版本 [ToolDefinition](https://github.com/can1357/oh-my-pi/blob/v18.20.0/packages/coding-agent/src/extensibility/extensions/types.ts) 的 approval read/write/exec 是工具级权限，不是工作台方案批准或人工验收。本次只调用无业务副作用的 read 工具，没有伪造或验证业务授权。AF-02 能力基线已完成观测并关闭；AF-11 必须定义独立可信授权，AF-04/AF-15 负责在生产 UI 中落实上述宿主替代机制并完成端到端验收。

### 9.2 AF-01 确认的实现差异

AF-03 已完成只读/执行边界分离与动作契约收口：`refreshHandoff` 不再隐式补记 `results.json`（历史已提交实施基线改由 `Context.pendingBaselineSync` 派生并通过显式 `handoff-reconcile-baseline` 补记）；`results-refresh-changes`、`handoff-send`、`results-run-verification` 等在 `Context.describeAction` 中显式标记修订与文件副作用；`Context.evaluateAction` 将 UI 禁用原因与 `host.luau` 最终命令门禁/失败原因统一为同一来源，且 `readiness` 按 `requirementId` 隔离 `workflow`、`results`、`reviews` 与 `pendingSend`。已有验收仍保持记录→阶段的分步发布，不宣称跨文件原子事务。

现有条件编辑按行重建 ID 且将 required 设为 true；普通审查 source=native_review 是人工声明；批量队列/部分草稿并未全面按需求隔离；部分旧路由无效；完整验证日志/diff 历史缺少可达阅读入口。分别在 AF-07、AF-09、AF-10、AF-06/08 处理，不能作为已完成能力继承。AF-03 先修正派生状态与建议动作；AF-09 明确零条件验收规则。

## 10. 工程落点

基于现有文件结构，建议如下；这是职责规划，不是已完成的代码重构。

| 文件/模块 | 重构职责 |
| --- | --- |
| window.luau、lib/ui.luau | 新壳层、首页、统一工作区、导航与草稿恢复 |
| lib/context.luau | 简洁上下文、派生主动作、删除阶段按钮导航 |
| lib/runview.luau | 交付信息重排为进展、实际变更与证据；手工表单移入按需入口 |
| lib/reviewview.luau | 审查材料与人工验收决策，不常驻导入协议说明 |
| lib/auditview.luau | 人类可读时间线与技术详情 |
| lib/handoff.luau、host.luau | 统一预览/执行确认、身份冻结、请求状态呈现 |
| styles.css | 语义 token、组件视觉与容器响应式；删除旧胶囊/彩条规则 |
| lib/validity.luau、workflow/results/review/store | 保留共享门禁、内容身份、CAS 与历史规则 |
| omp/index.ts、runtime.ts、handoff.ts | 工具注册、版本化能力声明、可信归属与授权校验 |

不要一次性重写巨大的 host；先建立统一动作分类与视图读模型，逐入口替换。视图读模型分别承载 lifecycle、request、connection、readiness，不持久化另一份派生状态。主动作从同一门禁结果计算，不在页面中各自猜测。

对于动作契约，明确区分 navigate/read/edit/decide/execute，并声明目标、可用原因、所需授权、影响与幂等策略。UI 分类不是安全边界，所有写入和执行仍必须由领域命令校验。

## 11. 交付顺序与退出条件

### A. 固定契约与交互能力

产物：动作清单、当前四类状态、工具边界、宿主组件能力矩阵、代表性夹具。保留各实体已有版本兼容（包括 plan v2、reviews v3，精确矩阵见领域约束），不因纯 UI 改造升级存储。

退出：每个旧功能都有新入口或明确删除理由；菜单、焦点、输入、富文本、容器宽度均有真实宿主探针结果。

### B. 新壳层与首页

实施列表、筛选、看板投影、导航恢复、统一主题 token。移除旧平铺筛选和重复导航。

退出：一条需求时内容不再被筛选淹没；返回恢复上下文；窄宽度无整页横向溢出；只读操作不写业务数据。

### C. 决策型工作区

实施概览/变更/记录，统一审批、执行与验收阅读流；保留高级手工入口。安全说明缩到对应动作，不在全页面反复重复。

退出：版本更新等完整工作流可通过新界面完成；用户在点击前能分辨查看、批准、执行和验收；已授权待执行等状态没有互相矛盾的提示。

### D. Agent 工具与授权范围

引入可信归属、结构化候选、稳定计划更新、验证执行请求、用户决策请求和幂等恢复。两端能力协商后才开放入口。

退出：普通流程不再要求手工输入 JSON 路径或逐步维护计划；Agent 不能批准自己、接受自己或伪造验证；工作台关闭、旧扩展、断连、重复请求均有明确结果。

### E. 清理与发布验收

删除被替代的视图、样式、重复状态解释、旧动作别名；保留必要的数据版本读取器与外部导入能力。更新 README/变更记录与当前设计权威说明，旧设计文档标明历史状态，避免多套互相矛盾的规范。

退出：自动回归与真实 Windows Tern 场景均通过。未通过的宿主能力不以截图或测试数量掩盖。

## 12. 验收矩阵

产品：
- 打开需求后，不展开技术详情也能理解目标、当前进展、需要自己做什么。
- 同一状态只有一个一致的主要行动建议。
- 阅读方案、返回列表、查看证据不发起推理或业务写入。
- 批准、开始执行、验收分别有可辨识的动作与记录。
- 默认流程无需填写 JSON 路径、UUID、哈希或手工计划步骤。

正确性：
- 内容 A→B→A 不复活旧授权；生命周期变化不错误地使新格式证据失效。
- A 运行时查看 B，不改变 A 的请求归属或 B 的草稿。
- 来源断开、预览后漂移、CAS 冲突、未知版本、重复点击均拒绝错误执行。
- 未知投递不自动重发，重载不自动恢复执行。
- 验证失败、过期、未知和未执行分别展示；没有验收条件不能伪装通过。
- 干净的新审查不清除未处置的历史阻断发现。
- Agent 无法通过工具输入获得人工批准或验收身份。

视觉与输入：
- 浅色、深色、自定义主题都测量正文、按钮、状态与焦点对比度。
- 360/492/800/1100px 下标题、主动作、错误原因完整可用。
- 中文 IME、多行、撤销、焦点恢复、异步刷新、切换需求与失败草稿恢复在真实窗口验证。
- 菜单/弹层不遮挡关键提交内容，不产生焦点陷阱；长文档阅读位置不随轮询跳动。

可用性验证：使用至少五名不熟悉实现的用户，观察查找需求、审阅批准、开始实施、解释失败、验收五项任务。记录误把导航当执行的次数、找到当前决策的时间、人工输入字段数与操作路径；这些是待测指标，不是已取得成果。目标是零危险语义误判，不能只靠减少点击数评价成功。

自动化复用现有领域、host、views 与 omp 协议测试，删除绑定旧文案/布局的脆弱断言，补充真实消费者行为回归。新视觉必须由真实运行表面验证；本设计阶段未执行构建、测试或新界面渲染。

## 13. 本次决策摘要

采用：单一任务入口、三页签工作区、单一主动作、文档优先、Tern-native 主题与组件语法、三层语义 Token、Agent 工具维护机械工作、人工批准与验收、共享领域校验、现有原生技术栈。

不采用：只有聊天框、所有能力塞进折叠栏、彩色全阶段导航、拖拽推进生命周期、自动批准/自动验收、靠模型文字认定成功、重写成独立 Web 产品、把工作台权限宣称为系统沙箱。

参考依据：[历史资料索引](archive/README.md)、[当前领域约束](DOMAIN_CONTRACT.md) 与 `styles.css`。历史资料中的测试记录仅描述原有实现，不代表本方案已实施或验收。
