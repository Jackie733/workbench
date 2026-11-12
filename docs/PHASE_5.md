# 阶段 5：审查、人工验收、审计与导出

日期：2026-11-12。插件 3.4.0。已实现原生 `/review` 预填入口、追加式审查与发现处置、人工接受／驳回／重新打开、按需求审计时间线与安全 Markdown 导出；阶段 6 的旧数据迁移和真实发布验收仍未实现。

## 范围

- 不复制审查引擎：只把 omp 原生 `/review` 明确预填到当前会话输入框；范围和提交由 omp 自身界面决定。
- 结构化记录审查来源、范围、代码快照与发现；发现处置和验收决定只追加，不覆盖历史。
- 阻断发现未关闭时禁止人工接受；必需验收条件必须存在当前代码快照上的通过证据。
- 人工接受才进入 `done`；驳回退回 `implementing`；重新打开 `done → clarifying`，旧验收历史保留。
- 按需求生成审计时间线，支持检索和安全 Markdown 导出。
- 明确不宣称本地日志不可篡改；普通文件编辑仍可能改动记录。

## 数据

```text
<repo>/.omp/workbench/requirements/<id>/
  reviews.json                 # 审查、发现处置事件、人工验收与重新打开
  results.json                 # 已有验证证据和代码快照
  exports/<REQ>-audit-<ms>.md  # 显式写入的导出
```

`reviews.json`（schema 1）：

```text
revision
reviews[]:
  id=review-<hex>, source=native_review|manual|external, scope,
  codeSnapshotSha256, requirementRevision, createdAt,
  findings[]: id=finding-<hex>, severity=blocking|major|minor|note,
              description, createdAt
  events[]:   id=review-event-<hex>, findingId, action=resolved|waived|reopened,
              reason, at
acceptances[]:
  id=acceptance-<hex>, decision=accepted|rejected,
  requirementRevision, codeSnapshotSha256,
  verificationIds[], reviewIds[], comment, createdAt
reopenings[]:
  id=reopening-<hex>, acceptanceId, reason, at
```

上限：审查 50、单次发现 50、单次处置事件 200、人工验收／重新打开各 20。达到上限时拒绝新增，**不丢弃旧记录**。`reviews.json` 仍通过项目门控 CAS 写入，但应用本身只追加；发现处置和改正是新事件，不原地改旧事件。

## 阻断门禁

人工接受要求：

1. 当前存在代码快照。
2. 每个 `required` 验收条件都有一条 `passed` 验证，其 `requirementRevision` 等于当前修订，且 `codeSnapshotSha256` 等于当前快照。
3. 所有 `blocking` 发现的最新处置不是 `open`；`resolved` 和 `waived` 都算关闭，但都必须有理由。

不满足时显示具体原因并禁用接受按钮；宿主侧再次校验，不能靠按钮隐藏绕过。没有审查记录不阻塞验收；审查不是强制流程，但一旦记录阻断发现就必须处置或豁免。

## 人工决定与阶段

| 操作 | 记录 | 阶段 |
| --- | --- | --- |
| 人工接受 | `acceptances` 追加 `accepted`，包含当前快照、验证 ID、审查 ID、说明 | `implementing/verifying/awaiting_acceptance → done` |
| 人工驳回 | `acceptances` 追加 `rejected`，必须填写原因 | 非 `implementing` 时 `→ implementing`；已在实施中则保留阶段 |
| 重新打开 | `reopenings` 追加，引用某次 `accepted` | `done → clarifying` |

阶段更新由独立的 `Store.advanceStage` 完成，只允许上述人工路径；不会让 `done` 重新进入方案采用或批准流程。验收记录先写，阶段更新失败时明确显示“记录已保存、阶段更新失败”，不静默假称完成。

## 原生审查入口

界面按钮只执行一次 `prefill`，把字面 `/review` 写入当前 omp 输入框：

- 不自动按 Enter，不选择范围，不发送提示词。
- 繁忙、已有待核对投递或已有草稿时由源端拒绝，不覆盖输入框。
- 回执显示 `prefilled`；用户随后在 omp 原生界面选择 base／未提交／提交／自定义范围并提交。
- 记录审查时需要用户手工填写来源、范围与发现；不从模型回复猜测发现或严重度。

## 审计与导出

审计页基于需求、工作流、计划、结果和审查记录实时生成事件，按时间倒序：

- 需求创建／当前修订、方案采用、批准与撤销、请求与回执、计划与步骤状态、实施基线、代码观察、验证、审查与发现处置、人工验收与重新打开。
- 检索按类型、摘要和引用过滤。
- Markdown 导出包含：需求与验收条件、方案元数据、批准、计划、基线与文件清单、提交、验证命令／退出码／结果／快照／关联条件、审查发现与处置、人工决定。
- 导出**不包含**验证 stdout/stderr、差异正文、聊天记录、认证信息或凭据。导出上限 128 KiB；超限拒绝生成不完整文件。
- 可复制到剪贴板，或显式写入 `.omp/workbench/exports/`。导出只是记录副本，不构成不可篡改证明。

## 本轮实际验证

隔离项目 `/tmp/wb-phase5`，Windows Tern 0.9.17＋WSL＋omp 18.19.0＋Luna：

- 初始化项目、创建中文需求，补齐范围与两条验收条件；直接授权并真实发送实施请求，回执 `submitted`，需求进入 `implementing`。
- 将 `code.js` 改为 2，运行 `node test.js`：退出码 0、结果 `passed`、当前快照指纹 `21420e26…`。这是由用户外部编辑完成，未宣称模型产出。
- 点击原生入口：回执 `prefilled · awaiting_user_submission`，omp 输入框出现 `/review`，未自动发送。
- 记录一次 `native_review` 审查（范围“未提交改动”）和一条 `blocking` 发现。门禁立即显示“阻断发现仍未解决或豁免”，接受按钮不可用。
- 追加一条 `resolved` 处置及理由；旧发现仍在记录中，事件追加成功。门禁转为通过。
- 填写验收说明并人工接受：验收记录写入，需求 `done`，需求修订 5；审计时间线同时显示验证、审查、发现处置和人工接受。
- 审计检索“验证”只显示验证事件；导出写入 `REQ-0001-audit-…md`（1862 字节），确认不含 stdout/stderr、聊天、认证或凭据。
- 填写重新打开原因并执行：新增 `reopenings` 事件，需求 `clarifying`、修订 6；原审查、验收记录和已完成历史均保留。最终项目处于重新打开状态，而不是虚构的最终完成。
- `reviews.json` 实测内容：一条审查、一个发现、一条 `resolved` 事件、一条 `accepted` 验收、一条 `reopening`；未覆盖旧字段。

自动：Bun 25 项通过（阶段 4 Git／协议覆盖保持不变）。本轮新增的 Lua 领域与 UI 主要通过真实 Tern 验证，未新增独立 Lua 测试运行器。

## 当前限制

- 审查内容仍需人工录入；不从 `/review` 输出自动抽取发现，避免把模型自然语言误当结构化事实。
- 驳回／重新打开路径已实现并真实重新打开；本轮未在第二个需求上单独实测驳回。
- 发现处置不可编辑旧事件；更正只能追加新事件。没有 UI 删除审查或验收记录的入口。
- 审计是应用内历史和只追加 UI，不是防篡改日志；本地文件仍可被用户修改。
- 导出不包含完整差异与验证输出，不能替代原始证据文件；需要完整证据时查看项目内对应记录。
- 搜索只针对当前选中需求的时间线；没有跨项目全文索引。
- 审查快照不自动阻止后续代码变化；门禁只校验验收时的当前快照与验证证据。代码变化后应重新验证，审查是否重做由用户决定。
