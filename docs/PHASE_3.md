# 阶段 3：资料交接、正式方案与批准

日期：2026-11-12。插件 3.2.0。已实现并接通原生界面；阶段 4 的执行证据、阶段 5 的审查／验收／审计与阶段 6 的迁移仍未实现。

## 范围

- 选择当前需求、项目相对文件与讨论摘录，生成**完整、有界**的交接预览。
- 明确预填到现有 omp（不推理），或明确发送并开始推理；不新增 omp、不排队 steer。
- 候选回复、项目文件和手写草稿只有在用户明确采用后才形成正式方案版本。
- 不可变版本、真实逐行差异、逐版本批注、明确批准／撤销、快捷实施授权。
- 需求内容、方案版本或 Git 基线变化使批准失效；源端在发送前再次校验。
- 未知投递不自动重发；可人工结束等待并保留未知记录。

## 数据

```text
<repo>/.omp/workbench/requirements/<id>/
  requirement.json
  workflow.json
  designs/v<N>.json
```

`workflow.json`（schema 1）保存 `revision, latestVersion, designs[], comments[], approvals[], approval?, requests[]`。`designs/v<N>.json` 为不可变完整正文：

```text
schemaVersion, projectId, requirementId, version, requirementRevision,
requirementSha256, body, sha256, source, createdAt
```

- `body` 上限 16 KiB UTF-8；超限拒绝，不截断。
- `sha256` 是正文精确字节的小写 SHA-256；在真实 PowerShell 中计算。
- `requirementSha256` 是规范化需求内容的 SHA-256，用于发现未提升 revision 的手工修改。
- 正式版本不覆盖、不删除；新采用只增加 `vN+1` 并使旧批准失效。

批准记录包含 `id, mode(design|direct), requirementRevision, requirementSha256, requirementContent, designVersion, designSha256, latestVersion, baseline{head,fingerprint,dirty}, approvedAt`，可带 `reason, revokedAt, revocationReason`。历史决定保留撤销原因和时间。

Git 基线由源端读取当前根、HEAD、已跟踪／未跟踪变化与文件内容摘要；业务元数据目录 `.omp/workbench` 被排除，避免保存审批时自己使审批失效。既有未提交改动会被记录并展示。

## 源端交接协议

命令沿用 `schemaVersion=1, requestId, instanceId, sessionId, createdAt, expiresAt`（30 秒有效）：

| kind | 字段 | 行为 |
| --- | --- | --- |
| `inspect` | `operation=preview` + requirementId/activity/includeRequirement/paths/excerpt | 只读生成完整预览，返回 `previewToken`、完整 `text`、`sha256`、需求修订、基线和来源文件摘要 |
| `inspect` | `operation=baseline` | 只读返回当前 Git 基线 |
| `inspect` | `operation=candidate` | 只从当前会话最后一条含文本的 assistant 回复返回候选；不是交付 |
| `inspect` | `operation=file` + path | 只读返回项目内一个普通 UTF-8 文件的完整正文与 SHA-256 |
| `prefill_preview` | `previewToken` | 重新校验预览与来源后，只把正文放入空编辑器 |
| `send` | `previewToken` | 要求已持久化的同 ID 发送意图；再次校验身份、需求摘要、来源文件、批准与基线后调用真实 `sendUserMessage` |

回执状态：`inspected / prefilled / submitted / rejected / delivery_unknown`。发送前先写 `delivery_unknown/applying_request` 认领；SDK 接受后才写 `submitted`。任何未知结果都不自动重试。

安全边界：

- 项目文件只接受相对路径；拒绝绝对路径、`..`、反斜杠、`.git` 与工作台元数据；逐段拒绝符号链接，并以打开后的 inode 再次确认仍在项目内。
- 预览文本上限 16 KiB 总字节；超限直接拒绝。源文件读取上限 16 KiB，候选上限 16 KiB。
- `send` 仅在 omp 空闲、无排队输入、无计划审阅且编辑框为空时执行；不 steer、不 follow-up。
- 实施发送额外要求：当前有效批准、相同需求内容摘要、最新正式版本指纹、当前 Git 基线一致，以及持久化发送意图。

## 原生界面

需求详情进入“资料 · 方案 · 批准”：

- **资料**：项目文件路径、是否加入完整需求、意图（澄清／设计／实施）、讨论摘录；显式生成预览后，完整展示目标项目／会话、需求修订、版本、来源文件摘要与全文。可只预填，也可明确发送。来源端预览令牌在重载或来源变化后失效，必须重新生成。
- **方案**：手写草稿；显式检查并导入项目文件或最后回复候选；明确采用为正式新版本。选择版本读取完整正文，并与另一版本做完整行级差异；批注绑定具体版本。
- **批准**：检查 Git 基线后明确批准最新方案，或单独记录直接实施授权的范围与理由。批准状态显示当前／失效原因；撤销保留历史。
- 待核对的发送保留同一 request ID，不重发。`applying_request` 只是进行中认领。最终未知可填写“人工核对说明”后结束等待：保留未知状态和说明，不取消任务、不重发；之后的发送必须重新生成预览。

## 本轮实际验证

自动（Node/Bun，23 项通过）：命令身份／过期／字段白名单、完整资料边界、路径与符号链接、需求／来源文件变化、预览过期与消费、候选不自动采用、Git 基线排除业务元数据、批准失效、直接授权依据、发送意图绑定。

真实 Windows Tern 0.9.16＋WSL＋omp 18.18.9（隔离项目与 Luna 会话；未向日常会话发测试提示）：

- 原生界面初始化、创建中文需求、IME 预编辑与提交、Emoji 中间插入。
- 完整资料预览包含所选文件与摘录；只预填成功；omp 已有草稿时 `send` 被 `draft_conflict` 拒绝且原文不变。
- 采用方案 v1/v2/v3，旧批准因新版本失效；版本完整差异、批注绑定与不可变旧版本。
- 修改来源文件后实施预览被 `baseline_changed` 拒绝；重新批准后预览成功。
- 未批准的实施预览被 `approval_required_or_stale` 拒绝；需求内容修改后直接授权立即失效。
- 正式方案批准后真实 `send` 返回 `submitted`，同一 Luna 会话收到完整交接并回复；需求进入实施阶段，未自动标记完成。
- 真实回复候选先显示，只有显式导入才进入草稿，未自动采用。
- 旧来源断开后的未知请求：人工填写说明结束等待，工作流保留 `delivery_unknown` 与 `resolution`，阶段未推进、未重发。

工作流自动化回归 `tests/workflow.luau` 在真实 PowerShell 下通过前 21 项（初始化、版本、CAS、批准、撤销、快捷授权依据、发送意图、未知回执、迟到肯定回执、重复回执）。阶段恢复与快捷实施发送的自动化分段受 Carly 单次 50 ms 切片预算限制未完整跑完；对应产品动作已由上述真实 UI 路径覆盖，未宣称该自动脚本全绿。

## 当前限制

- 不自动把下一轮模型回复归入任务；回复、工具成功、idle 都不等于交付或验收。
- 不提供自动合并、提交、推送、发布；不修改模型或 Provider 配置。
- 无多人协作、云同步、强事务或不可篡改审计；本地文件仍可被用户编辑。
- 方案正文目前是完整文本版本，不是结构化 AST；差异为完整行级前缀／后缀差异。
- 未知请求结束等待是人工对账动作，不改变“可能已执行”的事实。
