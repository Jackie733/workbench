# R0：共享门禁基线与只读有效性评估

- 日期：2026-11-13
- 状态：已实施。V01-V03 的领域部分有自动结果；真实 Tern 桌面与隔离 Git 场景尚未执行，未据此宣称完成。
- 依据：[重设计提案](REDESIGN_PROPOSAL.md) §4、[实施计划](REDESIGN_IMPLEMENTATION_PLAN.md) R0、[charter](../DESIGN_AND_IMPLEMENTATION_PLAN.md) §4.2。

## 1. 交付范围

新增 `lib/validity.luau`：一个纯表检查、只读、无 `tern` 依赖、不递增修订的评估模块，覆盖

| 函数 | 内容 |
| --- | --- |
| `approval(workflow, requirement, content)` | 批准是否仍对应当前需求修订、内容序列化、最新方案；返回 `{valid, reason, message, approvalId?, mode?, designVersion?}` |
| `verification(results, requirement, verification)` | 单条证据状态与原因代码（`requirement_changed`／`snapshot_missing`／`code_changed`） |
| `evidence(results, requirement, snapshot)` | 证据列表与 passed／failed／unknown／stale 计数 |
| `criteria(requirement, results, snapshot)` | 必需与信息性验收条件分开计数，逐项给出覆盖状态与证据 ID |
| `findings(reviewsData)` | 发现状态（最后一次处置事件胜出，`reopened` 回到未处置）与 total／open／blockingOpen |
| `acceptance(requirement, results, reviewsData)` | 验收门禁：稳定顺序的结构化原因 + 文案 + 实体引用 |
| `currentVerificationIds(...)` | 验收选用的当前快照证据 ID（修订与快照都必须匹配） |
| `evaluate(input)` | 上述组合的只读读模型，供 R1 的 readiness 摘要与“需要处理”投影使用 |

所有原先各自计算的路径改为委派，语义由一处决定：

- `lib/results.luau#effectiveState` → `validity.verification`
- `lib/review.luau#findingState`、`#acceptanceGate` → `validity.findingState`、`validity.acceptance`
- `lib/workflow.luau#approvalState` → `validity.approval`（内容仍由 `Workflow.requirementContent` 提供）
- `lib/reviewview.luau` 的覆盖统计与发现计数 → `validity.criteria`、`validity.findings`
- `host.luau` 的批准文案表与验收证据 ID 选择 → `validity.approval.message`、`validity.currentVerificationIds`
- 验收动作仍通过 `Review.acceptanceGate` 调用同一个门禁函数；动作时重新计算，不使用渲染时缓存

## 2. 校验点清点

| 位置 | 现有校验 | R0 处理 |
| --- | --- | --- |
| `lib/store.luau` | schema 与字段白名单、`Criterion.required`、阶段转换、CAS／锁 | 清点，未改 |
| `lib/workflow.luau` | `requirementContent`、批准、请求意图与回执状态 | 批准判定委派；写入路径未改 |
| `lib/results.luau` | 计划／结果／证据 schema、证据上限、`effectiveState` | 状态判定委派；schema 未改 |
| `lib/review.luau` | 审查／处置／验收 schema、发现状态、验收门禁 | 判定委派；schema 未改 |
| `lib/validity.luau` | 统一批准／证据／覆盖／发现／验收 | 新增 |
| `host.luau` | 验收动作、驳回快照、批准文案、证据 ID | 两处改用共享函数 |
| `lib/reviewview.luau` | 覆盖与发现计数、门禁展示 | 委派 |
| `lib/runview.luau` | 证据状态与失效原因 | 经 `Results.effectiveState` 委派 |
| `omp/handoff.ts` | `approved()`：批准、基线、方案正文重校验；`resolve()`：预览漂移、请求意图 | 清点，未改；跨语言镜像保留 |
| `omp/runtime.ts` | 命令／回执／预览字段白名单、活动白名单（仅 clarify／design／implement） | 清点，未改 |
| `tests/*.luau` | 原生 fs／PowerShell 的 CAS、恢复、协议与视图回归 | `tests/workflow.luau` 的依赖注入补上 `./validity` |

## 3. 行为差异（只此三项）

1. **无当前代码快照时，`passed` 证据显示为未知**（原因 `snapshot_missing`），不再显示绿色；`failed`／`unknown` 保持原结果，避免隐藏已记录的失败。验收门禁本来就在缺少快照时拒绝，现在交付列表与门禁不再互相矛盾。
2. 批准失效文案集中到 `lib/validity.luau`，逐字保留原 `host.luau` 文案；`Workflow.approvalState` 仍返回 `{valid, reason}`（新增 `message`）。
3. 其余判定顺序、原因文案、计数方式与选择规则逐项保持不变；领域写入路径（CAS、事件追加、修订递增）零改动。

## 4. 实际运行

环境：WSL Ubuntu；Lune 0.11.1；Bun 1.3.14；Node 24.18.0。

| 命令 | 结果 |
| --- | --- |
| `lune run tests/run-validity.luau` | 53 checks, 0 failures（新增） |
| `lune run tests/run-views.luau` | 984 checks, 0 failures |
| `lune run tests/run-host.luau` | 33 checks, 0 failures |
| `bun test omp/` | 28 pass, 0 fail |

未运行：`tests/store.luau`、`tests/workflow.luau`、`tests/concurrency.luau`、`tests/recovery.luau`（需要 Tern 内原生 fs／PowerShell），以及任何真实 Tern 桌面场景。

## 5. 验收矩阵对应

| ID | 现状 |
| --- | --- |
| V01 | 领域回归覆盖：当前通过证据、必需／信息性分离、failed／unknown、修订失效、快照失效、缺少快照、阻断发现（未处置／解决／豁免／重新打开）、非阻断发现、门禁与交付列表、验收选用证据一致 |
| V02 | `evaluate` 前后输入表与修订不变，模块无写接口、无 `tern` 依赖；宿主侧“查看／重算不写需求”仍由现有只读路径保证，真实桌面待 R1 |
| V03 | 同一组 fixture 中改变代码指纹后重新评估即变为 `stale` 且门禁失败；宿主验收动作在点击时重新调用门禁。未做隔离 Git 真实场景与桌面缓存徽章复验 |

## 6. 已知限制

- Luau 与 TypeScript 各有一份批准判定：`omp/handoff.ts#approved` 额外校验基线与方案正文，不能在 Luau 侧复用；后续若改批准语义，两处必须同时改并由协议测试覆盖。
- R0 不新增持久字段、不新增活动、不改变生命周期；`evaluate` 的 readiness 组合尚未接入界面（R1）。
- 未在真实 Tern 窗口验证窄／宽布局与交互；V02／V03 的桌面与隔离 Git 部分仍然开放。
