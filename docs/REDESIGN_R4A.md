# R4a：需求级持久资源绑定

- 日期：2026-11-13
- 状态：已实施，验证与宿主回归通过。未做真实桌面验收；保留的交接历史（E9）未包含。
- 依据：[重设计提案](REDESIGN_PROPOSAL.md) §5.2、[实施计划](REDESIGN_IMPLEMENTATION_PLAN.md) R4a。

## 1. E1 决定与存储

新增每需求文件 `requirements/<id>/resources.json`，schema 1：

```text
{schemaVersion:1, projectId, requirementId, revision, updatedAt,
 resources:[{id, path, kind: "context"|"verify", addedAt}]}
```

| 决定 | 内容 |
| --- | --- |
| 兼容 | 新文件；缺失＝未绑定，不推断、不回退。读取器严格校验字段白名单、ID／路径唯一、上限 32。未知 `schemaVersion` 或未知字段 → 只读错误，不重置、不丢弃。 |
| 写入 | 复用现有 CAS 与锁：`Store.putScoped` 增加 `resources.json` 路径；修订必须等于读取值 +1。 |
| 路径 | 仅项目内相对路径：无绝对路径、无反斜杠、无 `.`／`..`、无重复斜杠、无控制字符、≤2048 字节；不接受项目外附件。 |
| 迁移 | 没有旧数据需要迁移；旧二进制不读取也不改写该文件，仅会表现为“没有绑定资源”。 |
| 保留 | 随需求文件保留；当前没有删除需求的入口，因此没有级联删除问题。 |

## 2. 行为

- “准备交接”面板新增“绑定资源 · 仅本需求”：列出路径、用途（上下文／验证说明）与可读性；可移除或新增。
- 绑定变更立即使当前预览失效，并要求重新生成；预览把绑定路径与手写路径合并、去重，合计最多 16 个文件（与源端上限一致），超出直接拒绝。
- 缺失或超过 16 KiB 的文件在列表中标为不可读；预览时的源端读取仍是权威校验，失败不会被静默截断。
- 绑定资源与手写路径、摘要、需求内容一起构成预览；发送与预填仍沿用既有确认与回执流程。
- 绑定只记录引用，不复制内容，也不创建竞争性的规范文件；优先引用项目已有说明（如 `AGENTS.md`）。

## 3. 实际运行

环境：WSL Ubuntu；Lune 0.11.1；Bun 1.3.14。

| 命令 | 结果 |
| --- | --- |
| `lune run tests/run-resources.luau` | 24 checks, 0 failures（新增） |
| `lune run tests/run-views.luau` | 1165 checks, 0 failures |
| `lune run tests/run-host.luau` | 84 checks, 0 failures |
| `lune run tests/run-batch.luau` | 36 checks, 0 failures |
| `lune run tests/run-validity.luau` | 64 checks, 0 failures |
| `bun test omp/` | 28 pass, 0 fail |

覆盖：路径规范化与越界拒绝；schema 版本、未知字段、重复 ID／路径、未知用途、上限；宿主加载资源、显示可读性、拒绝越界新增；未知版本的资源记录使该需求只读；切回兼容需求恢复可读；面板渲染绑定列表与移除动作。

## 4. 验收矩阵

| ID | 状态 |
| --- | --- |
| V07 | 自动覆盖绑定资源的加载、失效与拒绝；真实桌面的资源变更／预览漂移未验证 |
| V13 | 覆盖 v1 合法／未知版本只读／损坏记录只读；升级中断、备份与恢复未执行（本轮无迁移） |

## 5. 已知限制

- 未实现 E9 的“保留交接历史／复用上次交接”：仍需新的持久元数据与保留策略。
- 资源列表的可读性检查是预检（最多读 16 KiB）；最终以源端预览读取为准。
- 不做外部附件、不复制内容、不自动把 `AGENTS.md` 之外的约定文件当作规范。
- 真实 Windows／WSL 路径与中文文件名尚未在桌面复验。
