# 重设计能力探针结果：审查来源、计划来源、活动扩展

- 日期：2026-11-13
- 环境：omp 18.20.0（实际安装，charter 研究时固定的是 18.18.7）；Tern 0.9.18；WSL Ubuntu。
- 方法：只读检查扩展契约使用（`omp/index.ts`、`omp/runtime.ts`、`omp/handoff.ts`）、已安装二进制的字符串与 CLI 帮助、现有本地测试。没有向任何会话发送提示，没有调用模型，没有修改协议或存储。
- P1（原生输入／IME／快捷键）需要真实桌面，未执行。

## P2 审查来源

| 问题 | 结果 |
| --- | --- |
| 是否有结构化审查事件或条目？ | 未发现。安装的二进制里 `/review` 是一个交互命令（`class D2 { name = "review"; description = "Launch interactive code review" }`），它构造审查提示并进入模型回合；没有看到审查结果的专用事件、custom entry 类型或稳定 finding ID。`omp.review.*` 只是内置界面的 role 名。 |
| 能否把一次原生审查绑定到 omp 请求／回合？ | 不能从扩展事件可靠获得。可观测的 `message_end`／`tool_result` 不携带“这是一次 /review”的标记；工作台现有 `review.source = native_review` 只是人工声明。 |
| 现有兜底是否仍成立？ | 成立：预填字面 `/review`，发现由人手动录入或明确采纳；工作台记录快照、需求修订与处置事件。 |
| 结论 | 不支持结构化导入。R5 若要导入，须新增协议（扩展侧捕获并标注审查来源、稳定 ID、范围、部分输出与重启行为），或继续“候选 + 人工采纳”。不把模型文本解析当作身份。 |

## P3 计划来源

| 问题 | 结果 |
| --- | --- |
| 观测到的计划从哪来？ | `todo` 工具的 `toolResult.details.phases`（`op ~= "view"`）或 custom entry `user_todo_edit.data.phases`；`omp/index.ts#observePlan` 已实现并受 `omp/runtime.test.ts` 覆盖。 |
| 结构 | `phases[] = {name, tasks[] = {content, status}}`；status 限定 `pending/in_progress/completed/abandoned/blocked`；最多 16 个阶段、64 个任务，超出标记 `truncated`。 |
| 身份是否稳定？ | 阶段内稳定：ID 为 `sha256(phase\0content\0occurrence)` 前 24 位；同样的阶段/内容重复出现时靠 occurrence 区分。它不是需求或请求 ID，跨计划编辑也不保证持久。 |
| 归属 | `attribution: null`；扩展事件明确写“no task attribution”，工作台只把它当会话观测，不推进需求。 |
| 结论 | 只支持“观测任务”，不支持“需求计划关联”。持久实施计划继续用工作台自己的稳定步骤 ID；把观测任务映射到需求需要显式关联协议（E5/E6），未批准。 |

## P4 活动扩展（review／analyze）

现状与边界：

- 运行时白名单：`omp/runtime.ts` 的 `Activity = "clarify" | "design" | "implement"`，`validateCommand` 拒绝其它值；`omp/handoff.ts` 的 `inspect` 只给 implement 做批准校验，其余活动按只读资料预览。
- 持久侧白名单：`lib/workflow.luau` 的请求校验同样是三值；回执会把 `clarify/design/implement` 映射到阶段。
- 旧端遇到新值的行为：旧扩展 `validateCommand` 返回错误，不写命令文件 → 新宿主只能得到“投递未确认”，不会把 `review` 误当 `design` 执行。这是安全的拒绝，但仍需显式测试与用户可见状态。

要新增 `review`／`analyze`，至少需要：

1. 版本化信封（命令 `schemaVersion` 与能力声明），旧端明确拒绝并可被宿主识别为“不支持的本意”，而不是投递未知。
2. 两侧校验器同步：TS 白名单与 Luau 请求校验、阶段映射（review 不推进实施阶段）、审计摘要。
3. 回执与恢复契约：新意图的 receipt、`delivery_unknown` 对账、重载后不自动重发。
4. 预览内容语义：review 是否包含需求全文、文件与摘录；批准不适用于 review。
5. 兼容测试：新宿主 + 旧扩展、旧宿主 + 新扩展、部分升级数据。

结论：技术上可做，但这是协议扩展（E9 范围），不是“把 review 当成 design 发送”。在批准前保持原生 `/review` 预填与人工发现录入。

## 对后续阶段的影响

- R5 的结构化候选、增量审查与计划关联需要新的来源或协议；当前只能做人工采纳与手动关联。
- R2 的“复用上次交接”仍受 E9（保留交接元数据）限制。
- 版本差异：安装的 omp 为 18.20.0，事件名在二进制中存在（`plan_review_requested`、`tool_approval_requested`、`user_todo_edit`、`session_tree`），但语义仍以实际运行时为准；任何新依赖都应在真实会话中复验。
