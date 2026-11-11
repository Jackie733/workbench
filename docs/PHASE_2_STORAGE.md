# 阶段 1.5 与阶段 2 存储层

日期：2026-11-11。状态：已实现并验证存储层；需求列表、详情和看板界面尚未实现，不宣称可用。

## 1.5 收尾

- 面板不再显示每次心跳变化的 `sequence`/`pid`，改为静态“连接正常 · 心跳持续（只表示会话仍在线，不代表任务进度）”。过期时显示“最后更新 N 秒前”。
- 创建桥接运行时 1 秒后，清理可证明已废弃的运行目录：名称合法、当前用户拥有、权限 0700、普通目录、marker 的 `instanceId` 与目录一致、PID 已不存在、目录 mtime 超过 7 天。无法证明或正在运行的一律不删。
- 每个 omp 实例仍会新建自己的 `/tmp/omp-workbench-<uid>/<instanceId>/`；正常退出不会立即删除，避免误删排查证据。

## 阶段 2 存储层范围

本层只负责项目元数据与需求的持久化、校验和并发安全。它是后续需求池、详情和看板的基础，不含模型调用。

数据位置：

```text
<repo>/.omp/workbench/
  project.json
  lock.json
  requirements/<requirementId>/requirement.json
```

不自动修改 `.gitignore` 或 `.git/info/exclude`。目录是否进入版本库由用户决定；界面阶段会在未忽略时提示。运行期 IPC 仍在 `/tmp`，不进入仓库。

### project.json

```text
schemaVersion=1, projectId, root(Linux 绝对路径), name,
revision, nextNumber, createdAt
```

- `projectId`、`requirementId` 为稳定随机标识，不使用目录名或标题。
- `nextNumber` 分配展示编号 `REQ-%04d`。分配先更新项目，再写需求；失败时允许编号空洞，不重复使用。
- 未知顶层字段拒绝；`extensions` 仅用于需求记录。

### requirement.json

```text
schemaVersion=1, requirementId, projectId, number, revision,
title, type(feature|bug|chore), priority(low|normal|high|urgent),
stage(backlog|clarifying|designing|awaiting_approval|implementing|
      verifying|awaiting_acceptance|done|blocked|cancelled),
goal, scope, acceptanceCriteria[], labels[], createdAt, updatedAt,
blockedFrom?, blockedReason?
```

校验上限：标题 200 字符、目标／范围各 16000 字节、验收条件 32 条（每条描述 1000 字符）、标签 16 个（每个 40 字符）。拒绝控制字符、非法枚举、未知字段和超限内容。阶段转换门禁尚未接入本层。

## 并发与原子性

### 写入锁

`lock.json`：

```text
schemaVersion=1, token, owner{window,panel}, updatedAt
```

- 初始化时先取锁：其他 token 且 `updatedAt` 在 15 秒内则返回 `locked`，不得写入。
- 锁过期后允许接管，并在界面阶段记录原因。锁文件自身使用直接写入，写后立即回读校验 token，防止两个窗口同时认为成功。
- 正常关闭时应释放；异常退出留下的锁在过期后可接管。

### 每次写入的 CAS

所有项目与需求写入都经过同一个 PowerShell 脚本：

1. 读取锁，token 不匹配 → 退出码 2（`lock_conflict`）。
2. 目标存在时解析其 `revision`，与调用方期望值不一致 → 3（`revision_conflict`）；目标不存在时要求期望值为 0。
3. 目标损坏无法解析 → 4（`corrupt_target`）。
4. 用 `MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH)` 在同一目录原子替换；临时文件不存在 → 5，发布失败 → 6。
5. 失败时删除临时文件，不覆盖目标。

负载先由 Lua 写入目标同目录临时文件，再交给 PowerShell 校验和发布，避免环境变量大小限制。脚本不接收需求正文作为命令行参数。

已知竞态：两个窗口可能在极短时间内同时通过 Lua 侧锁检查；脚本内再次校验 token，仍不能提供跨文件事务。应用层必须串行化本窗口写入，不在同一项目多窗口同时编辑。

## 实现

| 文件 | 职责 |
| --- | --- |
| `lib/store.luau` | schema 校验、编号、路径、锁、CAS 写入、项目初始化、需求读取 |
| `tests/store.luau` | 33 项生产逻辑回归；注入进程接缝，不依赖模型 |
| `omp/runtime.ts` | 1.5 的废弃运行目录清理 |

路径由扩展提供的 WSL 位置和项目 Linux 根目录构造为 `\\wsl.localhost\<distro>\...`；拒绝远程 host、相对路径和含反斜杠的 Linux 路径。

## 验证

自动：

```sh
bun test omp/runtime.test.ts   # 10 通过，含清理边界
```

Tern 内：

```text
run(tern, <仓库 UNC 路径>, <临时 UNC 路径>, yield)
```

`tests/store.luau` 的结果：33 项检查、0 失败。覆盖未知字段、超限、枚举、编号与 revision、路径拒绝、锁新鲜期与接管、根目录不匹配、CAS 冲突、错误 token、损坏目标、损坏需求报告。

真实 PowerShell（WSL UNC 路径）：

- 创建：状态 0。
- 以旧 revision 更新：状态 0，落盘 revision 加 1。
- 重复旧 revision：状态 3。
- 错误锁 token：状态 2。
- 真实初始化：创建项目；第二窗口立即初始化返回 `locked`；锁过期后可接管。

`tests/store.luau` 尚未接入自动 CI，需要在真实 Tern 中手动运行；不要把它当作跨平台测试。

## 未完成与风险

- 需求列表、详情、看板、搜索和阶段门禁 UI 仍未实现。
- PowerShell 每次调用都会 `Add-Type` 编译移动函数，单次写入有百毫秒级开销；批量导入需要合并写入。
- 超长 UNC 路径（>260 字符）在部分 Windows 配置下可能失败；当前未做 `\\?\UNC` 前缀适配。
- 锁是咨询性的；不宣称跨窗口强事务。
- KV 中的按会话草稿和“已解除待确认”记录没有枚举/清理 API，目前不会自动过期；体积很小，但会缓慢累积。
- 预填回执文件保留用于排查，当前无自动清理。
- 不提供审计事件日志；阶段 5 再实现追加式审计。
