# Agent-first 重构任务

唯一进度清单。设计依据：[DESIGN](DESIGN.md)；不可削弱的约束：[DOMAIN_CONTRACT](DOMAIN_CONTRACT.md)。本轮开始按 AF-01 → AF-02 执行；不继承历史 R0–R5 的完成状态。勾选与下面的执行记录是进度依据。

## 执行规则

- `[ ]` 表示未完成，`[x]` 只在交付物和验收证据齐备后勾选；进行中/受阻写入该任务的执行记录，不提前勾选。
- 每项记录实际修改、运行命令/场景、结果、证据路径与剩余风险；未运行必须明确写未运行。
- 先核对实际代码/SDK，再修改。共享领域规则复用现有实现，不做第二套较宽松校验。
- 修改 UI 必须观察真实 Tern surface；静态视图断言不是视觉、IME 或辅助技术证据。
- 当前用户已授权顺序执行 AF-01/02，再继续满足前置条件的任务；不提前重写 UI、不擅改存储协议、不操作日常项目。隔离探针与夹具不构成产品新能力。
- 不额外新建并行计划文档。API/兼容决定更新 DESIGN/DOMAIN_CONTRACT，进度与证据记在本文件对应任务。

## 任务与依赖

| 阶段 | 任务 | 前置 |
| --- | --- | --- |
| A 基线 | AF-01 契约盘点；AF-02 原生能力探针 | 无；AF-02 基于 AF-01 的表面清单 |
| B 公共基础 | AF-03 状态与动作读模型；AF-04 视觉基础 | AF-01；AF-04 另依赖 AF-02 |
| C 主界面 | AF-05 首页与看板；AF-06 工作区与成果阅读 | AF-03/04；AF-06 另依赖 AF-05 导航契约 |
| D 决策流程 | AF-07 创建与编辑；AF-08 批准与执行；AF-09 证据与验收；AF-10 异常/草稿/运行恢复 | AF-06；AF-09 另依赖 AF-08；AF-10 整合 AF-07/08/09 |
| E Agent 能力 | AF-11 版本化协议；AF-12 结构化读写工具；AF-13 授权验证与端到端接通 | AF-01/02/03 → AF-11 → AF-12 → AF-13；AF-13 另依赖 AF-08/09/10 |
| F 发布 | AF-14 兼容与故障回归；AF-15 桌面与可用性；AF-16 清理与交付 | AF-10/13 → AF-14/15 → AF-16 |

协议设计可与主界面实施并行，但共享 host、状态模型和领域写入入口必须有单一集成负责人；不得同时编辑同一共享入口后再猜测合并。新工具未达到同等能力前不撤掉手工兼容入口。

## A. 基线与能力

### [x] AF-01 核对功能、版本与动作契约

**设计映射：** DESIGN §2、§7、§10；DOMAIN_CONTRACT 全文。

**范围：** `host.luau`、`lib/ui.luau`、`lib/context.luau`、领域模块、`omp/index.ts`/`runtime.ts`/`handoff.ts`，既有测试入口。

**交付：**
- 逐项列出当前用户能力及新位置，覆盖创建、编辑、资源、预填/发送、方案采用/批准/撤销/直接授权、计划、diff、验证/批量、审查/处置、验收、生命周期、审计/导出、诊断。
- 每个动作分类为 navigate/read/edit/decide/execute，记录写入/执行副作用、权限、目标、失败与重复点击行为。
- 核对实际 schema 读写矩阵，特别是 plan v2/reviews v3、内嵌 PowerShell 读写器与恢复路径；差异更新 DOMAIN_CONTRACT。
- 固定隔离夹具：空项目、单需求、待批准、已批准待执行、运行中、失败、待验收、已完成、旧数据、断连、未知投递。

**验收：** 每个旧能力有新入口或有理由的删除决定；没有把愿景字段当成当前实现；门禁与读操作边界有可执行基线检查。

**执行记录（已完成，2026-11-13）：**
- 静态盘点覆盖真实 Luau 领域读写器、内嵌 PowerShell 与 TS 源端；矩阵与发布顺序已更新 DOMAIN_CONTRACT §1/§6。生产代码、协议与项目数据未改。
- 固定 `tests/af-fixtures.luau` 的 11 个内存夹具：empty/single/awaiting_approval/approved/running/failed/awaiting_acceptance/done/legacy/disconnected/delivery_unknown；使用合成身份/指纹，不是磁盘业务记录，不调用模型或执行命令。
- 本次实际运行 `/tmp/lune-bin/lune run tests/run-validity.luau`：86 checks、0 failures；`run-host.luau`：176 checks、0 failures；`bun test omp/handoff.test.ts omp/runtime.test.ts`：34 pass、160 expects、0 fail。日志：`target/af-baseline/baseline.log`。这些是现有领域/受控宿主与隔离源端回归，不是原生界面证据。
- 夹具检查通过需求验证器，readiness 计算前后内存 JSON 不变；输出见 `target/af-baseline/fixtures.log`。实际观察：approved 仍建议“检查并批准方案”，断连/未知投递仍建议开始澄清；这说明现有 readiness 未组合连接/请求状态，AF-03 必须修正，而非改写持久阶段。
- 发现 acceptance 存在快照且零必需条件时可能通过；底层 recordAcceptance 不独立证明人工身份，宿主当前在 review-accept 路径先检查 gate。AF-09/AF-13 必须保留可信调用链并明确零条件政策。
- 追加实际运行 `run-content-identity.luau`：27 checks、0 failures，日志 `target/af-baseline/content-identity.log`；仅内存发布器验证，不宣称原生写入/断电恢复通过。
- 功能迁移、动作分类/权限/重复边界、真实版本矩阵、11 个隔离夹具与可执行基线齐备；见下表及 DOMAIN_CONTRACT。完成的是盘点，不是修复全部发现或新界面验收。

#### AF-01 能力迁移与动作基线

下表分类针对业务语义；read 可能执行只读 Git/哈希检查，navigate 可能保存本地 UI 状态，但两者不得写需求版本或启动推理。各行的目标均为原始绑定项目/需求，不随查看项漂移。

| 当前能力 / 动作 | 分类、副作用与权限 | 失败/重复边界 | 新入口 |
| --- | --- | --- | --- |
| `wb-open-*`、`requirement=*`、`back-workspace` | navigate；切页、选中与 UI 状态 | 无目标则回列表；不清业务门禁 | 工作首页/三页签/返回 |
| `change:layout/sort/priorityFilter/stageFilter`、search | navigate；本地显示状态 | 不写 requirement；保留筛选 | 工具栏/视图/筛选 |
| `enable-edit` | edit；申请项目锁，非执行授权 | 锁冲突/不安全记录拒绝，需显式接管 | 首次写操作的只读解释 |
| `initialize`、`takeover-initialize`、`takeover` | decide；初始化/项目本地排除/锁写入 | 非空或不安全数据不能重置；接管须确认 | 空项目/项目菜单 |
| `new-requirement`、`edit-requirement`、`back` | navigate/edit；打开表单或返回并保留草稿 | 未保存草稿与待核对请求守卫 | 新建/更多中的编辑 |
| `save-requirement`、`rebase` | edit；前者创建 staging/更新 CAS 与内容身份；后者只重设草稿基线 | 冲突保留草稿；稳定创建 ID 重试有边界 | 需求编辑区 |
| `resources-add`、`resources-remove=*` | edit；resources CAS，失效预览 | 路径/上限/版本/修订校验 | 材料管理 |
| `handoff-prepare`、`open-handoff` | navigate；只打开交接 | 不生成意图/不发送 | 当前行动的准备区 |
| `handoff-preview`、`handoff-baseline` | read；源检查/哈希/Git，临时预览与基线 | 来源/文件/身份/大小失败拒绝，过期重建 | 方案/执行准备 |
| `prefill`、`prefill-selected`、`handoff-prefill` | edit/execute；prefill-selected 只填本地草稿，其他写 IPC/omp 输入但不推理 | 不覆盖已有草稿；实际投递核对来源/忙碌与在途请求，不重发 | 更多/交接预填 |
| `handoff-send` | execute；先持久意图，再 IPC，明确启动模型 | 批准/预览/来源最终重验；未知结果核对 | 明确执行确认 |
| `handoff-candidate`、`handoff-import-*` | read/edit；读取候选/导入草稿，不批准 | 来源/路径/正文上限检查；不自动采用 | 方案草稿/更多导入 |
| `handoff-adopt` | decide；不可变方案→阶段→workflow | 不同孤立方案冲突；不是跨文件事务 | 方案采用 |
| `handoff-comment` | edit；追加版本批注 | 有效版本/上限/CAS；不承诺通用幂等 | 方案阅读 |
| `handoff-approve`、`handoff-authorize-direct` | decide；写精确授权；不执行模型 | clicked/基线/内容/范围条件校验；重复不等于全局幂等 | 阅读后批准/更多直接实施 |
| `handoff-revoke` | decide；追加撤销事实 | 已撤销返回错误；理由必填 | 授权详情 |
| `handoff-end-wait`、`acknowledge-unknown` | decide；显式对账/结束等待，非终止进程 | 业务对账记录按原 request；不重新发送 | 未知结果提示 |
| `results-plan-add/generate/links`、`change:status-*` | edit；计划 CAS，稳定 ID/关联 | 条件/路径/状态/修订验证；完成量不是交付率 | 概览计划/高级编辑 |
| `results-refresh-changes` | read；观察 Git 并保存 results 观察快照 | 这里是**显式采集命令**，会写观察记录；普通“查看变更”不得自动复用此写动作 | 变更的显式刷新 |
| `results-preview-verification`、`results-use-candidate=*` | read/edit；命令发现/预览/填草稿，不运行命令 | 命令或条件变化使预览失效 | 验证准备 |
| `results-run-verification` | execute；真实进程→evidence→results | 来源/预览重验；超时 unknown；不是通用可重试写入 | 验证确认/未来授权工具 |
| `results-batch-add/remove/start/stop` | edit/execute；草稿列表与串行调度 | 停调度不杀进程；首失败/漂移停止；不自动续跑 | 高级验证 |
| `review-open-native` | execute；只预填 `/review` | 不解析模型文字为正式审查，不自动发送 | 审查准备 |
| `review-create/add-finding/remove-finding` | edit/decide；草稿发现/正式追加审查 | 原生来源为声明非认证；快照/输入/CAS 限制 | 审查材料 |
| `review-pick/inline/toggle/cancel` | navigate/edit；选择/本地处置面板 | 打开不写正式决定 | 对应发现详情 |
| `review-dispose`、`review-fix-draft=*` | decide/edit；追加处置或准备修复草稿 | 理由/发现校验；修复草稿不发送/不解 blocker | 发现详情 |
| `review-import-preview/adopt`、`results-import-preview/adopt` | read/decide；预览不写，采用单文件追加 | 冻结身份/文件/快照；同 ID 同指纹返回既有，异指纹拒绝 | 更多导入外部结果 |
| `review-accept/reject/reopen`、`lifecycle-open/confirm/dismiss` | navigate/decide；打开确认不写，最终记录决定与阶段 | 门禁/理由/活动请求保护；非进程停止；不复活旧验收 | 当前决策/更多生命周期 |
| `audit-refresh/copy/write`、`activity-refresh/write` | read/execute；事件查询/复制/显式导出文件 | 截断/扫描错误可见；导出不含聊天或验证全输出 | 记录/项目活动菜单 |
| `reload`、会话状态/诊断 | read；磁盘/来源重读与局部刷新 | 保留最后观测和错误；重载不重发 | 连接详情/恢复入口 |

“查看不写业务状态”特指阅读已有资料；显式采集代码观察、导出、预填均有可解释副作用，不能伪装为普通导航。UI 写保护不等于操作系统沙箱，领域低层方法也不是独立的权限服务。

### [ ] AF-02 验证原生组件与扩展能力

**设计映射：** §7.4、§9；历史探针只作为线索。

**范围：** Tern 原生 surface、现有窗口/host 输入路径、实际安装的 omp ExtensionAPI。

**交付：**
- 最小隔离场景验证菜单、弹层/替换阅读页、富文本、容器宽度、滚动、焦点恢复、禁用原因、主题 token。
- 验证中文 IME、Tab 顺序、Escape、撤销、异步刷新不丢输入以及 a11y 节点现状。
- 验证工具注册、调用上下文身份、面板关闭时可用范围与可信授权传递能力；不凭接口名推定支持。
- 将不支持项及可行替代记录在 DESIGN；必要辅助技术无法实现时作为发布阻塞/需明确决策事项，而非静默省略。

**验收：** 每个设计所需能力有真实观测或明确替代；不操作日常工程、不向日常会话发送测试请求。

**执行记录（已执行探针，未完成验收，2026-11-13）：**
- 新增可复用隔离插件 `tests/native-capabilities/` 与 SDK 探针 `tests/af-extension-probe.ts`；只安装到临时 Tern 配置，不修改日常插件安装/设置、默认模型、Provider 或业务项目。独立 control 57994 的真实窗口已关闭；不是在日常窗口内创建标签。
- 已核实版本：Bun 1.3.14、Lune 0.11.1、omp 18.20.0、Tern 0.9.18（6f1fa0f）、工作台 3.7.1。本项目 LSP 无配置服务器。实际 `tern plugin types` 导出在 `target/af-baseline/tern.d.luau`。
- 实际隔离需要同时设置 TERN_CONFIG_DIR 与 TERN_DAEMON_SOCKET。单独换配置后 plugin list 仍返回日常 daemon 插件；改成独立 socket 后只显示 af-capability-probe。离屏 shot 的显式 new_block 断言失败，空白截图不算验证；改用 Windows 真窗口成功加载。
- 真窗口已观察：Markdown 标题/列表/内联代码/链接、select/listbox 菜单、modal overlay、长内容滚动、禁用按钮的原因及点击无 forbidden 事件、Escape 后宿主 frame 恢复 editor 焦点。原生 a11y 树包含 Heading/TextInput/Button/ComboBox；推翻“所有 surface 一律没有 a11y 节点”的泛化，不等于生产界面或读屏器已验收。
- 宽度证据为 800px 整窗下的 371px 分栏 surface、339px 编辑器；整窗请求 360px 被系统夹到 720px。不能将命令参数冒充实际容器宽度。后续查明隔离配置 theme=Light 固定外观；按 Settings API 真实枚举设置 Dark 后真窗口成功变深色，证据 `target/af-baseline/dark-confirmed.png`。
- 输入根因已核实：commit 为 key 事件，探针必须维护缓冲；收到 focus 后必须发 frame focus。补齐后 preedit span 可见。F6 安排 300ms 重绘，在组合期间等待 500ms 后仍有“组合”span，refresh=1；提交后持久文本为“初始保留”（`native-events-redraw.json` / `native-redraw-preedit.json` / `redraw-composition.png`）。最初坐标点击未触发 refresh 的尝试不计成功。Ctrl+Z 单键撤销有事件与图证，但组合撤销分组、跨字段 Tab 与 modal 焦点循环仍未完整验收；AF-02 保持未勾选，不提前进入 AF-04 UI 实施。
- SDK 离线注册结果在 `sdk-report.json`；另执行一次真实隔离单回合，工具白名单仅 af_capability_probe，不保存会话、不加载项目上下文/扩展/规则，未使用日常会话。`sdk-dispatch-report.json` 显示 native tool dispatch、真实 toolCallId、main/print、独立 sessionId/cwd、providerRequests=1、执行期 addAdditionalContext=true。只验证 read 工具和无面板上下文；未验证业务授权，AF-11 仍必须自建可信契约。
- 日志/状态位于 `target/af-baseline/`；截图在 `target/shots/tern/live/af-capability-*.png`。最终输入证据为 `native-ime-confirmed.log` 和 `native-events-redraw.json`；早期失败/直接 handler 调用不冒充最终成功。隔离窗口已关闭，未对日常项目作写入。

## B. 公共基础

### [ ] AF-03 统一只读状态与动作模型

**设计映射：** §5、§6、§10。

**范围：** `lib/context.luau`、`lib/validity.luau`、视图数据适配与 `host.luau` 动作分发。

**交付：** 分离 lifecycle/request/connection/readiness；统一下一步建议、阻塞原因与新鲜度；定义动作目标/权限/影响与失败呈现。需要处理队列从领域事实派生，不新增待办数据库。

**验收：** “已批准待执行”不再同时建议重新批准；无快照不显示绿色成功；查看不增加 revision；切换需求不重归属异步结果；各页与最终命令使用同一门禁结果。

**验证：** 既有 validity/host 回归，补充尚未覆盖的消费者可见冲突场景。

**执行记录（进行中，2026-11-13）：**
- AF-01 已满足前置，AF-02 探针执行后继续不依赖新组件的读模型部分；未重写 UI 或升级 schema。
- `lib/context.luau` 将持久生命周期、原请求待核对状态、连接/观测时间与派生 readiness 分开返回，并复用 `Validity.evaluate`。断连不显示可执行就绪，未知投递建议核对原请求；会话工具活动不冒充需求归属。
- 有效批准的下一步改为“查看实施准备”，通过独立导航路由打开 implement 草稿并失效原活动的预览；没有自动批准、生成请求或发送。`host.luau` 在路由入口重新取当前派生结果，未知/待核对请求不切实施活动。
- 新增 `tests/run-context.luau`（17 checks、0 failures）；宿主回归 179 checks、0 failures；视图回归 1480 checks、0 failures。实际日志 `target/af-baseline/read-model.log`。后续将归属回归收紧为“相同内容/修订、不同 requirementId”的场景，仍为 17 checks、0 failures，见 `read-model-ownership.log`。已有门禁回归在 AF-01 已运行，本轮未改 `Validity` 规则。
- 使用隔离 native 插件加载真实 context 模块与合成 approved/delivery_unknown 夹具，观察主操作分别为“查看实施准备”“查看请求结果”。截图 `target/af-baseline/approved-final.png`、`unknown-final.png`；这验证现有生产 context 的修正，不是新界面完成证据。
- **未完成部分：** 当前导航中的历史基线补记仍可能写 results；完整命令权限/动作影响与各入口的统一尚未切换。不能把已通过的只读 readiness 测试推广为“所有导航都纯读”。AF-03 保持未勾选；不得跳过这些边界进入 AF-05。

### [ ] AF-04 落地视觉 Token 与基础组件

**设计映射：** §6、§8、§9。

**范围：** `styles.css`、共享视图组件，作用域限定工作台。

**交付：** 浅深色语义 token、字体/间距/圆角、按钮等级、状态标签、列表、输入、弹层、焦点与异常提示；移除旧黑色胶囊、普遍彩条、嵌套卡片和装饰发光。保留宿主主题映射。

**验收：** 普通文本对比度达到 4.5:1；必要边界/焦点达到 3:1；状态不只靠颜色；主操作与导航明显不同；360px 下没有整页横向溢出。

**验证：** 隔离原生表面的浅/深/自定义主题截图与实际对比度记录，不以 CSS 数值推断视觉通过。

**执行记录：** 未开始。

## C. 主界面

### [ ] AF-05 重做工作首页与可选看板

**设计映射：** §3、§4。

**范围：** `window.luau`、`lib/ui.luau`、首页状态与搜索/筛选处理。

**交付：** 紧凑项目栏、搜索、筛选弹层、视图菜单、简洁列表；仅存在可处理事项时显示决策区；活动/诊断进入项目菜单但异常全局可见。看板采用只读四组投影，受阻和未知状态不丢失，取消可筛选，窄面板纵向分组。

**验收：** 一条需求时不铺满筛选控件；行点击仅导航；返回恢复搜索、筛选、排序和滚动；空数据/无结果/读取失败可区分；无拖拽绕过业务转换。

**验证：** 真正打开单需求与多需求场景，分别在窄/宽面板导航和过滤。

**执行记录：** 未开始。

### [ ] AF-06 建立三页签工作区与成果阅读

**设计映射：** §3、§5.1、§8、§9。

**范围：** `lib/ui.luau`、`context.luau`、`runview.luau`、`reviewview.luau`、`auditview.luau`。

**交付：** 概览/变更/记录；目标、单一决策、进展、验收条件与资料；方案正文/真实 diff/证据阅读；移除阶段按钮导航、重复需求列表与嵌套批准标签。完整技术身份、哈希、原始来源保留在对应详情及复制入口。

**验收：** 不读内部协议也能理解任务；Markdown 按 AF-02 已验证能力呈现；长文与截断提示可达完整内容；每个上下文最多一个强调主操作，运行停止入口不因此消失；记录/导出沿用同一事件来源。

**验证：** 长中文方案、超长路径、差异、失败输出与历史记录的真实阅读场景。

**执行记录：** 未开始。

## D. 决策与恢复

### [ ] AF-07 简化新建、编辑与资源维护

**设计映射：** §5.2、§6、§9。

**范围：** 需求表单、资源选择、草稿与只读模式入口。

**交付：** 目标优先的新建表单；范围/条件/材料按需展开；创建只保存，整理需求另行明确启动；编辑前呈现对批准/证据的影响；只读启用不重放原操作。手工维护入口不丢失。

**验收：** 不填写标签/优先级/全部步骤也能创建；生成前不伪造标题或条件；取消编辑不写实体；中文草稿失败保留，成功清理当前动作草稿；更新内容按现有规则失效。

**执行记录：** 未开始。

### [ ] AF-08 统一方案批准与执行授权

**设计映射：** §5.3、§5.4、§6。

**范围：** `lib/handoff.luau`、`workflow.luau`、方案阅读与 `host.luau`，源端校验适配。

**交付：** 审阅入口与最终批准分开；展示精确版本、变更范围、风险、验证方式及相对上次批准的差异；批准后独立开始实施。明确预填/发送差别、目标会话及影响；直接实施有独立范围/理由/验收授权。

**验收：** 批准不自动发送；已有 omp 草稿不覆盖；内容/基线/来源漂移重新预览；未知旧记录显示无法比较；重复点击不重复执行；动作名字明确后果。

**验证：** 方案更改、A→B→A、旧记录、忙碌、输入冲突、预览过期和来源切换场景。

**执行记录：** 未开始。

### [ ] AF-09 重排验证、审查与人工验收

**设计映射：** §5.4、§5.5、§7。

**范围：** `runview.luau`、`reviewview.luau`、`results.luau`、`review.luau`、现有批量执行路径。

**交付：** 准确命令/目录/条件/超时预览；证据摘要与原始输出；失败/过期/未知分开；审查来源及发现处置；验收材料阅读与明确接受/要求修改；高级菜单保留手动验证、计划编辑与外部导入。

**验收：** 0/0 不表现为已覆盖；新干净审查不清除旧 blocker；历史通过不等于当前通过；验收前重算门禁，Agent 声明不产生通过；重新打开保留历史。

**验证：** 隔离命令失败/成功/改写工作区、阻断处置、条件改变、证据失效与人工验收的完整路径。

**执行记录：** 未开始。

### [ ] AF-10 完成异常、草稿与运行恢复体验

**设计映射：** §5.6、§6、§9。

**范围：** 导航、异步事件、请求核对、输入草稿、生命周期与错误呈现。

**交付：** 断连新鲜度、未知投递核对、冲突恢复、损坏/未知版本只读状态、忙碌保留草稿；按项目/需求/动作隔离草稿；返回/关闭恢复焦点；取消需求与请求停止分开。

**验收：** 运行 A 查看 B 不串数据；重载不发送/不续跑；未知结果没有默认重试；活动运行禁止不安全生命周期转换；停止调度不显示进程已终止；状态刷新不抢焦点/丢 IME 输入。

**执行记录：** 未开始。

## E. Agent 工具能力

### [ ] AF-11 固定版本化工具协议与单一写入路径

**设计映射：** §7.2–7.4；DOMAIN_CONTRACT §5–7。

**范围：** `omp/index.ts`、`runtime.ts`、`handoff.ts` 与宿主命令适配。

**交付：** 可信绑定、能力声明、信封/schema、有限载荷、超时/错误、CAS、授权引用与幂等契约；新旧端兼容矩阵；同一领域命令路径；面板关闭时明确可用/不可用行为。若需持久化字段，先给出实体版本、容量与恢复设计，再实施。

**验收：** 旧端不理解的新意图明确拒绝且可识别，不伪装成 design；同键异载荷拒绝；回调丢失可核对；模型无法自授人工身份；不新增旁路业务写入器、后台服务或模型客户端。

**执行记录：** 未开始。

### [ ] AF-12 实现结构化查询、候选与计划工具

**设计映射：** §7.1–7.3。

**范围：** 工作台查询、候选、计划、用户决策请求和证据读取工具；复用现有 Store/领域命令。

**交付：** `workbench_list/get/propose/update_plan/request_decision/get_evidence` 逻辑能力；最终注册名在 DESIGN 固定。摘要与详情按需读取，正式方案与候选分离，计划稳定 ID 与可信归属；变化目标/范围/验收条件只能提候选。

**验收：** 普通流程不再要求用户填 JSON 路径/哈希/手抄计划；重复调用不重复生成正式记录；无法归属的观测保持未知；计划工具不能改变验收条件、批准或完成验收；全部输出有界且不泄露凭据。

**验证：** 使用真实扩展工具调用与隔离需求完成读取、候选、采用和计划更新，不只测试 mock 注册。

**执行记录：** 未开始。

### [ ] AF-13 接通授权验证与 Agent 决策闭环

**设计映射：** §5.4、§7。

**范围：** `workbench_run_verification`、执行器、授权与决策 UI、候选采用全链路。

**交付：** 准确验证请求绑定命令/目录/条件/身份/授权；授权内执行、范围外请求人决策；结果由执行器写证据；UI 决策返回原请求。新工具未就绪前保持旧安全入口，不隐藏缺失能力。

**验收：** 用户表达目标→Agent 提方案→人工批准→明确执行→真实验证→人工验收可闭环；Agent 无法自行批准/验收/写 passed；修改命令或身份不能复用授权；串行执行停止/重载/未知结果符合现有边界。

**验证：** 隔离真实会话与代码项目，包含批准拒绝、命令越界、身份漂移、重复请求和一次完整成功路径。

**执行记录：** 未开始。

## F. 集成与发布

### [ ] AF-14 验证兼容、故障与安全边界

**前置：** AF-10、AF-13。

**交付：** 混合历史版本、新宿主/旧扩展与旧宿主/新扩展组合、写入冲突、未知字段/版本、回调丢失、重复/乱序回执、断连重载、完整备份恢复；明确单文件发布与断电保证差异。

**验收：** 历史数据与采用清单保留，旧授权不复活，重复执行/错目标发送/伪造人工决定均被拒绝；当前支持的版本不被误当空库；无新迁移则不制造迁移测试。

**检查入口：** 按实际变更选择 `lune run tests/run-validity.luau`、`run-store-lifecycle.luau`、`run-content-identity.luau`、`run-host.luau`、`run-views.luau`，以及 `bun test omp/handoff.test.ts omp/runtime.test.ts`；原生持久化使用既有 native 场景。命令可用性与所需驱动由 AF-01 核实，不把此列表当作已执行结果。

**历史承接：** R2 成功收发/乱序、R3b 停止/重载、R4b 活动中生命周期与完整恢复仍需覆盖，不由旧自动回归替代。

**执行记录：** 未开始。

### [ ] AF-15 完成真实桌面、输入与可用性验收

**前置：** AF-10、AF-13。

**交付：** Windows Tern 真实窗口、360/492/800/1100px 容器、浅/深/自定义主题、系统缩放、长文本、中文 IME、多行/撤销/焦点、菜单/弹层、断连/失败/运行状态的证据；记录真实版本与观测限制。

**验收：** 无整页溢出、焦点陷阱、跳动误点或静默丢稿；关键动作和后果可区分；普通文本/控件对比度达标；辅助技术按实际能力报告，不用截图证明 a11y 通过。

**可用性：** 按 DESIGN 组织至少五名不熟悉实现的用户完成查找需求、批准、执行、解释失败、验收。记录人数、误判、路径与问题；无人可参与时保持此任务未完成，不能用开发者自测冒充用户研究。

**历史承接：** 旧桌面已证明的局部 IME 场景不代替新结构的输入/撤销/Tab 顺序验收。

**执行记录：** 未开始。

### [ ] AF-16 清理旧实现与完成交付记录

**前置：** AF-14、AF-15。

**交付：** 删除被替代的导航/视图/样式/动作别名及只测旧文案的断言；保留版本读取器和外部结果兼容入口；更新 README、CHANGELOG、DESIGN 和领域约束。记录实际证据和遗留风险，不再创建第二套进度记录。

**验收：** 默认流程无常驻 JSON/内部身份表单，无新旧 UI 双入口；全部 AF 任务满足退出标准；完整任务闭环在真实宿主通过；用户项目和历史数据未被清理误伤。

**执行记录：** 未开始。

## 发布判定

全部任务打勾不是形式要求：未完成的真实桌面、辅助技术、安全、恢复或用户研究必须保持可见，不默认豁免。若外部能力阻塞且用户明确调整范围，先修改对应验收契约并写明原因，再讨论发布；不得静默把困难场景删除。

历史文档清理不改变发布状态。本轮已执行的检查以对应任务记录为准；所有尚未满足的验收继续保持未完成，不因局部测试或探针成功关闭。
