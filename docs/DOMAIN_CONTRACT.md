# 阶段 0：领域、持久化与恢复契约

日期：2026-11-11。状态：领域与后续完整流程的目标契约。阶段 0＋1 实时桥和阶段 2 已实施，实际字段、存储保证与界面边界以对应阶段记录为准；不表示阶段 3–6 已实现。

## 1. 身份与版本

所有正式记录包含 `schemaVersion: 1`。未知版本必须拒绝修改，保留原始文件，不按空数据初始化。UTF-8 JSON 中时间为 Unix 毫秒整数，ID 为不含路径分隔符的稳定字符串。

- 项目使用随机稳定 `projectId`，规范 Git 根目录为属性；移动目录不能重新分配需求身份。
- 需求使用随机稳定 `requirementId`，`REQ-0008` 是项目内唯一展示编号，不当作跨项目身份。
- 每次明确交接分配唯一 `requestId`，同一请求禁止重复消费。
- omp `sessionId`、进程 `instanceId`、Tern window/pane 分开保存，pane 不能替代 session；会话切换使旧绑定失效。
- `revision` 为业务实体单调递增版本；并发保存须携带预期版本，冲突拒绝覆盖。
- `eventId` 唯一；来源 `sequence` 只在该来源内有序，不能比较不同进程的序号。

## 2. 实体 schema

下表字段均为必需，明确标为可空的字段使用 null；可扩展元数据仅置于独立 `extensions` 对象，不能悄悄忽略未知必需字段。

| 实体 | 字段与类型 |
| --- | --- |
| Project | projectId:string, root:string, name:string, revision:integer, createdAt:time |
| Requirement | requirementId:string, projectId:string, number:string, revision:integer, title:string, type:feature/bug/chore, priority:low/normal/high/urgent, stage:下述枚举, goal:string, scope:string, acceptanceCriteria:Criterion[], labels:string[], createdAt:time, updatedAt:time, blockedFrom:stage/null, blockedReason:string/null |
| Criterion | id:string, description:string, required:boolean |
| DesignVersion | requirementId:string, version:integer, requirementRevision:integer, sourceRequestId:string/null, relativePath:string, sha256:string, status:proposed/approved/superseded, createdAt:time |
| Approval | id:string, requirementId:string, requirementRevision:integer, designVersion:integer/null, designSha256:string/null, baselineId:string, mode:design/direct, actor:user, approvedAt:time, invalidatedAt:time/null, reason:string/null |
| Plan | requirementId:string, revision:integer, designVersion:integer/null, steps:Step[], changeReason:string, updatedAt:time |
| Step | id:string, title:string, status:pending/active/done/blocked/skipped, evidenceIds:string[], reason:string/null |
| Run | requestId:string, requirementId:string, requirementRevision:integer, instanceId:string, sessionId:string, kind:clarify/design/implement/verify/review, state:下述枚举, model:string/null, startedAt:time/null, endedAt:time/null, approvalId:string/null, baselineId:string/null |
| Baseline | id:string, requirementId:string, head:string, capturedAt:time, trackedDiffPath:string, untrackedFiles:string[], dirty:boolean, sha256:string |
| Change | id:string, requestId:string, baselineId:string, capturedAt:time, commits:string[], files:string[], diffPath:string, sha256:string, attribution:observed_since_baseline/mixed/confirmed_by_user |
| Verification | id:string, requestId:string, criterionIds:string[], codeSnapshotSha256:string, requirementRevision:integer, argv:string[], cwd:string, startedAt:time, endedAt:time/null, exitCode:integer/null, outputPath:string/null, result:running/passed/failed/unknown/stale, redacted:boolean |
| Review | id:string, requirementId:string, requestId:string/null, codeSnapshotSha256:string, source:string, findings:Finding[], createdAt:time |
| Finding | id:string, severity:blocking/major/minor/note, description:string, resolution:open/fixed/waived, evidenceIds:string[], reason:string/null |
| Acceptance | id:string, requirementId:string, requirementRevision:integer, codeSnapshotSha256:string, verificationIds:string[], reviewIds:string[], decision:accepted/rejected, actor:user, comment:string, createdAt:time |
| AuditEvent | eventId:string, projectId:string, sequence:integer, time:time, actor:user/omp/workbench, type:string, entityIds:string[], requestId:string/null, payload:object |

文本草稿独立保存，不能覆盖正式 DesignVersion。附件记录相对路径、指纹和授权范围；项目外附件只读且显式确认。输出体积受限，截断保存须标明，不得冒充完整证据。

## 3. 状态与转换

`stage` 枚举：backlog、clarifying、designing、awaiting_approval、implementing、verifying、awaiting_acceptance、done、blocked、cancelled。

正常路径：backlog → clarifying → designing → awaiting_approval → implementing → verifying → awaiting_acceptance → done。

例外：

- awaiting_approval → designing：用户要求改方案。
- backlog/clarifying → implementing：必须保存 direct Approval、验收条件和起始 Baseline。
- verifying → implementing：记录验证失败或用户要求修复。
- awaiting_acceptance → implementing：人工驳回，记录原因。
- 任意未完成阶段 → blocked：保存 blockedFrom 和原因；解除后返回原阶段。涉及需求／方案变化时先失效 Approval。
- 任意未完成阶段 → cancelled：用户明确操作。正在运行时先请求中断；取消需求不声称后台工具已终止。
- done/cancelled → clarifying：用户明确重新打开，保留历史 Acceptance，不把它作为新版本已验收。

Run.state：draft、pending、accepted、running、waiting_user、ended、failed、cancel_requested、cancelled、delivery_unknown。业务 stage、Run.state 和 transport connected/stale/disconnected 是三组状态，禁止互相覆盖。

`ended` 只表示一次运行停止；只有明确采用的产物才构成设计交付。后台工作未结束不能发布终态。仅工具调用不报错不能构成 Verification.passed。

## 4. 批准与验收不变量

1. Approval 引用具体需求修订、方案正文指纹和实施前基线。方案、范围、验收条件变更使其失效。
2. 开始实施前重新读取并核对；既有未提交变更保留，基线变化必须展示并重新确认。
3. 开始后的预期代码改动不自动撤销本次授权。外部改动混入时标 mixed，不能宣称精确作者归属。
4. Verification 引用实际代码快照；相关代码／验收条件变化使其 stale，历史记录不删除。
5. 无可靠退出码、命令来源或快照的结果为 unknown，不使用模型自然语言代替证据。
6. 已完成只能由用户 Acceptance.accepted 触发；必需验收条件缺证据或阻断发现未关闭时拒绝验收，除非用户明确记录豁免。
7. 切换看板需求不改变运行请求；单会话只认领一个活动工作台请求，手工插入活动标为共享上下文。

## 5. 持久化、单写者与中断恢复

正式数据位于 `.omp/workbench/`；实时 IPC 和心跳位于当前用户私有临时目录，不进入 Git。阶段 1 不初始化需求数据库或写入虚构任务。

采用单项目写入协调者和版本前置条件，不采用最后写入覆盖。后续持久化实现使用下列文件事务：

阶段 2 当前采用 gate 内单文件 CAS、完整 staging 目录发布、稳定 ID 重试与允许编号空洞的本地协议，已验证回调中断后的列表完整性；尚不包含下述审计实体／事件的跨文件事务。详见 [实际存储协议](PHASE_2_STORAGE.md)。以下事务记录为后续完整审计切换的目标，不将阶段 2 的单实体保证冒称整个流程已完成。

1. 获取项目锁，锁包含本机实例、PID、随机 owner token；已有锁不可直接删除。PID 存活且身份无法核对时拒绝写入。跨窗口接管须显式确认。
2. 将本次完整实体更新与审计事件写入 `transactions/<txId>.pending.json`，包含原修订、目标修订和各文件指纹，原子 rename 完成准备。
3. 各实体写入同目录临时文件后原子 rename；事件追加需按 eventId 去重。
4. 全部落盘后将事务标为 committed，再释放锁。不得把所有平台上的 rename 都宣称为断电持久保证；实际实现需按平台 flush 能力标明边界。
5. 启动发现 pending 时先只读核对：文件符合目标则补齐审计，符合原修订则重放，出现不符则进入冲突恢复，不覆盖用户数据。
6. 恢复只处理本地持久化，不重发模型请求、不恢复旧批准、不自动执行命令。

应用界面中的审计只追加；更正追加事件。本地文件仍可被用户修改，不能声称防篡改或提供操作者真实性证明。

## 6. 旧数据迁移规范

来源：`tern.kv` 的 `tasks:<project.key>` schema 2，以及 `.omp/workbench/tasks/<task-id>/design.md`。旧 Canvas schema 1 元数据仅作为已知历史输入。

迁移必须在阶段 6 显式执行；阶段 1 保留来源，不提前转换或丢弃数据。

| 旧字段／阶段 | 目标 |
| --- | --- |
| id | 保存 legacyTaskId；生成稳定 requirementId，维护单独映射防止重复迁移 |
| title / goal | 标题／目标原样保留，验收条件缺失标待补充 |
| draft | backlog |
| designing | blocked，blockedFrom=designing，原因“历史运行待核对” |
| design_ready | awaiting_approval；方案内容需读取验证，旧批准一律无效 |
| executing | blocked，blockedFrom=implementing，原因“历史运行待核对” |
| attention | blocked，原因保留旧 message/error，不猜原阶段 |
| review | awaiting_acceptance，但证据不足，需人工核实，不能自动完成 |
| done | 历史完成标记保留；导入为 awaiting_acceptance，不能虚构人工验收 |
| bindings.design/execute | 仅保留历史引用；不绑定新会话、不启动角色 |
| designPath / head / designHead | 历史产物／基线引用，不伪装新快照 |

迁移前导出原始 KV 和方案副本；按项目和 legacyTaskId 建映射，重复执行不得增加副本。损坏或未知数据独立报告，不以空对象替换。只有完整验收后才切换写入源，备份保留。

## 7. 完整业务样例与证据链

示例需求 `REQ-0008`：会话过期后显示重新登录入口。

1. Requirement revision 1，验收条件 C1“过期时显示入口”、C2“有效会话不受影响”。
2. 设计请求 R1 产生 DesignVersion 1，引用需求修订和方案指纹。
3. 用户 Approval A1 绑定 revision 1、方案 v1 和 Baseline B1；开始实施请求 R2。
4. Plan 的 S1“定位”、S2“修复”、S3“验证”拥有稳定 ID。新增 S4 必须记录变更原因，而不是伪造固定进度。
5. Change CH1 记录 B1 之后实际观察的 diff，原有改动或混合编辑明确标识。
6. Verification V1/V2 记录真实命令、退出码、C1/C2 和代码快照 K1；未执行不得填 passed。
7. Review RV1 发现 F1，处理后生成新快照 K2，则 K1 上的验证保留为 stale，补充新验证。
8. 用户 Acceptance AC1 引用 revision 1、K2 和有效证据才将需求置 done。
9. 所有转移以 AuditEvent 引用相关实体；读到完整证据链才能声称业务闭环完成。

该样例用于后续 schema／行为验收，不在阶段 1 写成真实业务数据，也不构成已经运行测试的声明。
