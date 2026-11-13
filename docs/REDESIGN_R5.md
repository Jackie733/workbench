# R5：结构化外部候选与人工采用

状态：已实现并通过解析、领域、宿主／视图、隔离原生写入与真实桌面预览／采用验收。其它阶段桌面场景与发布验收仍未完成；可选增量审查未启用。

依据重设计提案 §6.4、实施计划 R5；用户授权继续实施并委托架构决策。R4b 的桌面、IME 与完整恢复验收仍未关闭。

## 决策与边界

- E5/E6/E9 本轮采用项目内 JSON 文件作为显式外部候选，不假设已安装 omp 存在可靠的原生结构化审查事件。静态探针只是“未发现支持”，不是证明所有运行路径都不支持。
- 原生 `/review` 保持字面预填；不解析自然语言为发现或完成状态，不新增 review/analyze 发送活动，不改 IPC 协议、不自动调用模型。
- 导入分为预览和明确采用。预览不写领域记录；采用追加正式审查或待办步骤，不批准实施、不运行验证、不接受需求。
- 可选增量审查不启用。仅接受 `complete: true` 的完整范围声明；部分／增量字段或不完整输出拒绝。该声明不是经过工具证明的覆盖；零发现的新审查不能关闭或清除旧阻断发现。
- 条件／文件关联仅表示人工计划意图，不产生验证证据，不保持失效证据有效，不改变全局代码指纹失效策略。
- 从发现准备修复只创建包含审查／发现 ID 和快照的实施交接草稿；不覆盖已有草稿，不自动授权或发送，不将发现设为解决。

## 候选文件契约

UTF-8 JSON，最大 16 KiB，schema 1，严格字段白名单、连续数组、稳定 ID 唯一；不截断采用。文件必须在项目内，经既有源端安全文件读取校验，不能使用绝对路径、符号链接越界、`.git` 或工作台内部文件。

公共字段：`schemaVersion`、`kind`、`id`、`projectId`、`requirementId`、`requirementRevision`、`requirementContentRevision`、`codeSnapshotSha256`、`planRevision`、`complete`。其中内容修订是 R4b 的单调身份，不是内容哈希；未升级需求按其当前实体修订取值。

以下为格式示例，身份／修订／完整指纹必须从当前工作区读取并替换，示例不是可直接采用的项目事实：

```json
{
  "schemaVersion": 1,
  "kind": "review",
  "id": "external-review-001",
  "projectId": "project-example",
  "requirementId": "req-example",
  "requirementRevision": 8,
  "requirementContentRevision": 3,
  "codeSnapshotSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planRevision": 2,
  "complete": true,
  "scope": "完整工作区与本需求范围；说明实际审查边界",
  "findings": [
    {"id": "F1", "severity": "blocking", "description": "可复现的问题与影响"}
  ]
}
```

计划候选将 `kind` 改为 `plan`，删除 `scope`／`findings`，添加：

```json
"steps": [
  {"id": "P1", "title": "修复入口", "criterionIds": ["C1"], "filePaths": ["src/login.ts"]}
]
```

审查最多 50 个发现，可声明零发现；严重度仅 `blocking/major/minor/note`。计划必须有 1–40 个步骤，每步最多 32 个条件 ID、32 个安全相对文件路径。条件必须明确存在，不从步骤标题或文件重叠猜测关联。候选禁止携带步骤完成、发现处置、验收等字段。

预览固定原项目／需求／会话／实例、精确需求修订、内容修订、计划修订、代码指纹与文件 SHA-256。采用前再次读取原文件与当前代码变化；任何目标、修订、指纹或文件变化均拒绝并要求重新预览。外部 `id` 是声明的来源标识，不是假冒已认证的原生 finding ID。

## 持久化与兼容

| 文件／消费者 | 读版本 → 新写版本 | 新字段与保留规则 |
| --- | --- | --- |
| `plan.json`／Results／Delivery／Audit | 1/2 → 2 | `candidateImports`；步骤 `criterionIds`／`filePaths`；旧步骤不补造关联 |
| `reviews.json`／Review／Acceptance／Audit | 1/2/3 → 3 | `candidateImports`，旧审查、处置、人工决定与重开记录原样保留 |
| Store scoped CAS／内嵌 PowerShell | 按文件区分版本 | 仅 plan 允许 2、reviews 允许 3；不扩大其它实体允许版本 |
| Requirement／workflow／results／evidence／project／resources／IPC | 沿用 R4b | 本轮无新字段或新活动 |

采用清单保存候选 ID、原文件 SHA-256、外部 ID 到新内部 ID 的对应；审查清单另有所属 review ID。计划清单最多 40 条、审查最多 50 条，仍受原记录 256 KiB 与步骤／发现总量上限约束，到限拒绝，不删除历史。

同一候选 ID 与相同文件指纹重复采用，领域层返回既有结果而不再写入；同 ID 不同指纹报告冲突。已有步骤 ID 不重写，候选只追加 pending 步骤；从条件生成步骤写明确条件关联。

沿用项目锁与单文件 CAS，不新增跨文件事务、后台升级或新的候选数据库。新写入才升级对应容器，旧条目不回填来源。发布失败保留旧正式文件，回调丢失后读取采用清单核对，不自动重发或继续采用。未知版本拒绝；新写入后旧读取器可能只读拒绝，不允许通过手改 schema 数字降级。回滚仍需一致的完整目录备份，不能单独丢弃新清单。

## 验收重点

- V15：缺失身份、重复 ID、未知字段、超限、部分输出、条件不存在、计划／代码／需求／绑定漂移均拒绝；预览零领域写入。
- V08：双击与回调丢失后核对不产生重复正式记录；文件变化不能复用已确认预览。
- V16：完整零发现候选不消除历史 blocker；不启用“干净增量等于全局干净”的路径。
- V13：旧容器混合读取，新写保留所有历史，未知版本不初始化为空；失败不改写已加载输入。
- 真实桌面与中文 IME 记录见 [桌面验收](REDESIGN_DESKTOP.md)；源码／视图契约测试不充当原生交互证据。

## 实施与验证记录

2026-11-13，WSL2、Lune 0.11.1、Bun 1.3.14、Tern 0.9.18。没有新增依赖，没有修改模型、Provider、全局插件或日常会话。

| 检查 | 实际结果 | 范围 |
| --- | --- | --- |
| `lune run tests/run-candidates.luau` | 69 checks，0 failures | 严格字段、完整声明、数组连续性、ID 唯一、路径、当前目标与快照、清单结构；校验只读 |
| `lune run tests/run-candidate-adoption.luau` | 123 checks，0 failures | 生产 Results／Review／Store API；内存 FS 与 CAS；采用、幂等重放、指纹冲突、漂移、损坏、失败不改写历史 |
| `lune run tests/run-host.luau` | 176 checks，0 failures | 预览／采用的双重来源检查、原文件与快照冻结、连点与漂移拒绝、草稿隔离、审计链接；受控回调边界 |
| `lune run tests/run-views.luau` | 1480 checks，0 failures | 预览、采用、关联编辑、修复草稿动作与页面渲染；不是原生输入证据 |
| `lune run tests/run-content-identity.luau` | 27 checks，0 failures | review 新写 schema 3 与旧历史保留 |
| `lune run tests/run-store-lifecycle.luau` | 175 checks，0 failures | plan 2／reviews 3 的按文件 CAS 门禁、未来版本拒绝、未知字段拒绝 |
| `lune run tests/run-validity.luau` | 86 checks，0 failures | 门禁与采用后证据策略不变 |
| `bun test omp/` | 34 pass，0 fail，160 expects | 源端文件／Git／授权／意图契约不变 |
| Tern `shot` 驱动 `tests/native-candidate-adoption.luau` | 15 checks，0 failures，phase 11 | 真实 Tern FS 与 PowerShell CAS：plan1→2、review1/2→3、采用映射、幂等、冲突、未知条件、历史阻断保留、人工处置保留来源 |

原生候选验收命令：`tern shot <临时 scenario.txt> --out <repo>/target/r5-native --theme light --size 1100x900`。场景每次原生 Lua 调用推进一个 phase（共 11 次），逐阶段断言 failures 为空，末次断言 done。结果保存在 `target/r5-native/`；临时工程和驱动已清理。原生首次失败暴露了 `table.clone` 对受保护 JSON 数组的兼容问题；改为逐键深拷贝后通过，未放宽校验。

隔离 `TERN_CONFIG_DIR` 的 `shot` 仍不加载插件；改用隔离 Tern 会话和临时工程完成真实预览、采用、窄宽度与中文 IME，见 [桌面验收](REDESIGN_DESKTOP.md)。该记录关闭 R5 的 V15／V16 桌面部分，但不关闭其它阶段场景与发布验收。
