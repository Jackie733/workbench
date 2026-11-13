# 阶段 1.5 与阶段 2 存储层

日期：2026-11-11。阶段 2 已接入原生需求界面；本文记录实际存储协议，不代表方案批准、执行归属或验收已实现。

## 阶段 1.5

运行快照不再把心跳序号／PID 当进度展示。IPC 心跳留在用户私有 `/tmp/omp-workbench-<uid>/<instance>/`，不写入需求文件。旧运行目录只在身份、所有者、权限、PID 已不存在和超过 7 天均可核对时清理；无法证明废弃的不删。

## 数据布局

```text
<repo>/.omp/workbench/
  project.json
  lock.json
  lock.json.gate
  requirements/<requirementId>/requirement.json
  .pending-<requirementId>-<attemptNonce>/requirement.json
```

`.pending-*` 是明确创建期间准备的完整记录，不是正式需求，不在看板中冒充已保存。成功后整个目录移动到正式位置。中断、超时或发布结果不确定时可能保留供排查；不自动重放请求。

初始化前提供两种明确选择：仅本机（向本仓库 `.git/info/exclude` 添加 `/.omp/workbench/`），或遵循项目 Git 规则（不修改规则）。保留既有排除内容，不改全局 Git 配置或 `.gitignore`；已有被跟踪的资料不会因忽略规则变成私有，选择仅本机时拒绝继续，不自动取消跟踪。忽略不是加密。

只读打开不创建项目数据；初始化、取得编辑权、接管和保存均为显式操作。

## Schema 1

`project.json`：`schemaVersion, projectId, root, name, revision, nextNumber, createdAt`。

`requirement.json`：`schemaVersion, requirementId, projectId, number, revision, title, type, priority, stage, goal, scope, acceptanceCriteria[], labels[], createdAt, updatedAt`，可选 `blockedFrom, blockedReason, extensions`。

- ID 稳定随机生成，目录使用 requirementId，展示编号为 `REQ-%04d`。
- 类型：`feature / bug / chore`；优先级：`low / normal / high / urgent`。
- 阶段支持完整领域枚举，但新建固定为 `backlog`，普通编辑保留阶段和身份，不能伪造批准、实施或完成。
- 时间为 Unix 毫秒整数；`tern.now()` 是单调计时，不用于业务或租约时间。
- 当前文本上限按 UTF-8 字节：标题／项目名 200、目标／范围各 16000、每条验收描述 1000、标签 40。验收最多 32 条，标签最多 16 个。
- 拒绝无效 UTF-8、非法枚举、未知正式字段、非连续数组、重复验收 ID、目录与记录身份不符、跨项目记录、重复展示编号和落后的 nextNumber。
- 损坏或未知版本不会被当作空项目初始化；保留原文件并报告，只读等待处理。

## 单写者与 CAS

`lock.json` 保存 `schemaVersion=1, token, owner{window,panel}, updatedAt`。token 属于一个具体工作台，不由项目内多个窗口共用。`window` 是 Tern 原生窗口 key：首个窗口的真实 key 就是空字符串，因此空字符串合法，不得当作缺失；`panel` 是正整数面板 ID。认领与续租先用与读取端相同的规则校验 owner，避免写出自己读不回的锁。

所有认领、续租、释放和发布使用同一个 `lock.json.gate`，由 Windows `FileShare.None` 独占句柄覆盖检查和写入。句柄释放后保留空 gate 文件，避免删除再创建导致不同进程锁住不同文件。锁元数据通过同目录临时文件和 `MoveFileEx` 原子替换，UTF-8 无 BOM。

- 其他 token 的锁在 15 秒内有效：`locked`，保持只读。
- 过期后仍要求显式接管：`takeover_required`，不会自动抢占。
- token 改变或锁缺失：拒绝续租／保存，不重新凭空生成锁。
- 损坏锁（包括 JSON null、不完整 owner 或未知 schema）拒绝覆盖，接管也不能绕过。
- 每次写入在 gate 内核对 token、目标版本和期望 revision。创建要求目标不存在；更新要求正整数版本严格相等。不采用最后写入覆盖。

创建顺序：准备唯一完整 staging 目录 → 项目 CAS 消耗编号 → gate 内无替换地移动整个目录。取消回调或重载不会留下只有空目录的正式需求。跨这两个发布点不宣称事务：中断可消耗编号，允许空洞，不复用。相同稳定 ID 的相同资料重试返回已落盘记录；资料不同则返回 `requirement_id_conflict`，不悄悄清掉新版草稿。

确定失败清理本次准备数据；超时、宿主重载等结果不确定时保留 staging。不自动迁移旧业务数据，不恢复批准，不触发模型调用。

主要错误：`lock_conflict / revision_conflict / corrupt_target / corrupt_lock / locked / takeover_required / busy / publish_conflict / timeout`。错误保留草稿，不能以空列表或“保存成功”掩盖。

## API

- `paths / readProject / readRequirements`：定位与只读校验。
- `init(paths, opts, cb(project,error,cx))`：显式初始化或取得编辑权；`takeover=true` 才允许接管过期租约。
- `create(paths, project, fields, token, cb(requirement,project,error,cx))`。
- `update(paths, requirement, expectedRevision, token, cb(requirement,error,cx))`。
- `renewLock / releaseLock`：受 gate 保护的异步操作。
- `runProcess(env,nil)` 保留原生 Awaitable，回归仅适配回调交付，不伪造写入器。

## 本轮实际验证

Windows Tern 0.9.16，WSL Ubuntu，omp 18.18.7；没有向模型发送测试提示。

| 回归 | 检查数 | 结果 |
| --- | ---: | --- |
| `tests/store.luau`：真实初始化、显式接管、创建／编辑、稳定 ID、损坏保护及 CAS | 55 | 通过 |
| `tests/concurrency.luau`：两个真实 PowerShell 同时保存／认领，失败者不能覆盖，临时正文清理 | 13 | 通过 |
| `tests/recovery.luau`：真实编号落盘后取消回调，既有需求完整，显式重试与去重 | 9 | 通过 |

2026-11-12 修复首窗口空 key 写入后不可读的问题，新增 5 项检查（空 `window` 是合法身份、空白 `window` 与非法 `panel` 仍拒绝、首窗口初始化落盘身份）。真实 PowerShell 认领与后续 CAS 发布路径已用生产脚本单独验证（空 `window` 锁可写、可读回并完成发布）；完整 Luau 套件待下次在 Tern 内运行。

在 Carly 中读取对应文件的返回函数，传入 `(tern, repoUNC, uniqueTempUNC, waitOne, waitAll)`。辅助函数：

```lua
local function waitOne(a)
  return await(a or tern.process.run({"cmd.exe", "/d", "/c", "exit 0"}))
end
local function waitAll(items) return await_all(items) end
```

无参数让出用于 Carly 的 50 ms 调用预算；宿主块预算为 2 秒。测试真实运行生产 PowerShell，不使用回显 CAS 的假写入器。当前未接入跨平台 CI。

另实测隐私模块：中文路径、保留原排除内容、重复选择幂等、不修改项目规则的选项，以及已有跟踪资料拒绝被伪称私有。

## 边界

- 是同一台 Windows／WSL 的本地单写者协议，不是多人数据库或跨文件强事务，也不宣称断电持久保证。
- PowerShell 启动、原生移动函数编译及续租有进程开销；没有新增常驻服务。
- 未完成 staging 保留待排查，当前不自动过期删除；旧会话 KV 与 IPC 回执保留策略见阶段 1 记录。
- 不提供正式方案版本、批准、代码证据、审计事件或人工验收；这些仍按后续阶段实施。
