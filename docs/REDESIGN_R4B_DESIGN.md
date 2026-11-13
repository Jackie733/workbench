# R4b：内容身份与显式生命周期转换

- 日期：2026-11-13
- 状态：已实现并通过领域／宿主／源端回归；原生工作流 PowerShell 写入通过。生命周期桌面交互、IME 与完整升级恢复验收仍未完成。
- 依据：[重设计提案](REDESIGN_PROPOSAL.md) §4.2-§4.3、[实施计划](REDESIGN_IMPLEMENTATION_PLAN.md) R4b（E8）。

## 1. 问题

实体 `revision` 是 CAS 版本：任何写入（包括阶段变化、回执、元数据）都会递增。批准、验证证据与验收目前都绑定 `revision`：

- 批准记录保存 `requirementRevision` 与 `requirementContent` 摘要；阶段变化后 `revision` 增加，批准即使内容未变也会显示失效。
- 验证证据保存 `requirementRevision`；任何后续阶段写入都会使“当前快照上的通过证据”失效。
- 验收检查同时依赖需求修订与全局代码指纹。

结果是：与批准／证据输入无关的写入也会使授权和证据失效，用户被迫重复批准或重跑验证；同时，任何“为了不失效而不写 revision”的捷径都会削弱审计。

## 2. 目标与边界

- 引入**内容身份** `contentRevision`：保存最近一次内容变化所产生的 CAS 修订；与实体 `revision` 分离。
- 生命周期转换（阻塞／解除／取消／重开）递增实体修订，但保持内容身份，因此不撤销新格式中与内容无关的授权或证据。
- 不追溯伪造历史：旧记录在升级后仍按旧规则判断，直到新写入建立内容身份，或明确标注不可比较。
- 不引入自动推进：转换只能由用户显式触发；被动观测、idle、readiness 不写生命周期。

## 3. 内容身份的初始字段集

保守集合与现有 `requirementContent` 一致：标题、类型、优先级、目标、范围、验收条件（ID、描述、必需／信息性）、标签。

- 身份 = `contentRevision`，内容变化时取本次新 CAS 修订。不能只用哈希：A → B → A 必须产生新的身份，不能复活旧授权。
- 既有 SHA-256 和批准中的规范内容串仍单独核验，不替代单调身份。
- 不纳入：阶段、阻塞原因、时间戳、Git 基线、代码快照。
- 方案版本、代码快照、执行授权仍是独立输入；预览／发送继续绑定精确实体修订，任何预览后写入都要求重新预览。

## 4. 消费者矩阵

| 消费者 | 当前依据 | 目标依据 | 兼容行为 |
| --- | --- | --- | --- |
| `Validity.approval` / `Workflow.approvalState` | 修订 + 内容串 + 最新方案 | 单调内容修订 + 精确内容串 + 方案版本／指纹 + 撤销状态 | 旧批准无身份时仍比较实体修订；不补造身份 |
| `Validity.verification` | `requirementRevision` + 代码快照 | `requirementContentRevision` + 代码快照 | 旧证据无身份时仍按实体修订比较；保留历史 |
| `Validity.acceptance` / `Review.acceptanceGate` | 修订 + 快照 + 必需条件 + 阻断发现 | 内容身份 + 快照 + 条件 + 发现 | 与证据评估同一规则；无法比较时拒绝 |
| `Acceptance` / `Review` 新记录 | 实体修订 + 快照 | 同时记录实体与内容修订 | 旧记录不补造身份；重开保留验收历史 |
| 请求意图（`workflow.requests`） | 修订 + 内容串 | 保留精确修订／载荷校验，附加内容身份 | 不放宽预览后漂移检查 |
| `omp/handoff.ts#approved` 与 `resolve` | 修订 + 内容串 + 基线 | 批准按内容身份；发送仍按精确实体修订 | 宿主与源端同步读 1/2；未知版本拒绝 |
| 审计／导出 | 实体修订 | 显示实体／内容修订与生命周期事件 | 旧事件不补造身份 |
| 恢复／存储 | schema 1 白名单 | 指定实体读 1/2、写 2 | 未知版本拒绝，不回退、不重置 |

## 5. 生命周期转换

| 触发 | 写入 | 内容身份 | 授权／证据 | 禁止 |
| --- | --- | --- | --- | --- |
| 标记阻塞 | 阶段 = blocked，保存原阶段与原因 | 不变 | 新记录不变；界面不得暗示执行已停止 | 活动操作／待核对请求期间转换 |
| 解除阻塞 | 阶段 = 原阶段，清除当前阻塞字段，追加历史 | 不变 | 当前输入重新评估；旧失效批准不复活 | 自动切到实施中 |
| 取消 | 阶段 = cancelled，追加原因／历史 | 不变 | 保留；不宣称进程终止 | 取消即删除证据或隐式重开 |
| 重新打开 | done/cancelled → clarifying，追加原因／历史 | 不变 | 不继承旧验收为当前完成状态 | 自动重新批准 |
| 接受／驳回 | 保留人工决定及内容身份 | 不变 | 接受前仍以当前事实复核 | 用审查通过代替验收 |

实现顺序：先内容身份（读旧写新），再转换；两者都要求源端与宿主同步，否则出现“界面有效、源端拒绝”或反之。

## 6. 存储与恢复

| 文件／条目 | 读／新写版本 | 新字段 | 上限与保留 |
| --- | --- | --- | --- |
| `requirements/<id>/requirement.json` | 1/2 → 2 | `contentRevision`、`lifecycleEvents` | 历史 200 条，原因 2000 字节；保留全部旧事件 |
| `workflow.json` 的方案元数据／批准／请求 | 1/2 → 2 | 新条目 `requirementContentRevision` | 原文件 256 KiB 上限；旧条目不回填 |
| `designs/vN.json` | 1/2 → 2 | `requirementContentRevision` | 正文 16 KiB、创建后不可变 |
| `results.json` 的验证条目 | 1/2 → 2 | 新条目 `requirementContentRevision` | 最多 50 条，历史失败与失效证据保留 |
| `evidence/verification-*.json` | 新写 2 | `requirementContentRevision` | 创建后不可变，沿用输出截断标记 |
| `reviews.json` 的审查／验收 | 1/2 → 2 | 新条目 `requirementContentRevision` | 审查 50 条、验收／重开各 20 条；不删除旧决定 |
| project／plan／resources／锁／IPC | 1 → 1 | 无 | 不参与此次 schema 升级 |

- Requirement、workflow、正式方案、results、验证 evidence、reviews 的新写入使用 schema 2；project、plan、resources、锁与 IPC 仍为 schema 1。
- Requirement v2 必有 `contentRevision` 与 `lifecycleEvents`。新方案／批准／请求／验证／审查／验收含 `requirementContentRevision`。v2 容器保留的旧条目可以没有身份，但继续按原规则判断；v1 禁止混入新身份字段。
- 旧需求只在正常实体写入时升级；升级时未改变内容则继承原实体修订作为内容身份。未升级需求的新记录也可绑定该实体修订，不需要提前写需求。
- 生命周期历史与阶段同在 requirement.json 单文件 CAS 发布；最多 200 条，到限拒绝，不截断。原因必填，UTF-8 上限 2000 字节。
- 从阻塞状态离开时，新事件保留实际存在的 `previousBlockedFrom`／`previousBlockedReason`，包括旧数据的单独字段或空原因；不伪造缺失字段或历史时间，避免升级时丢失旧阻塞信息。
- 沿用锁／CAS／同目录临时文件发布，不新增多文件迁移事务。升级发布失败保留旧正式文件；回调中断后先读磁盘，不自动执行外部请求。
- 新写入后不承诺旧二进制可写或可降级；遇到 v2 的旧读取器拒绝。不要手改 schema 数字“降级”。需要回滚时先停写、完整保存当前目录，再恢复一致的旧目录备份；不能只回滚单个文件。

## 7. 验收场景（实施时）

- V02：查看／重算 readiness 不写修订。
- V13：v1 与混合版本项目；未知字段／版本；升级中断；旧二进制在新写入后只读。
- V14：阻塞／解除／取消／重开分别在有活动请求、已授权、已验收后执行；原因与历史保留；不宣称终止进程；失效授权不复活。
- V01：内容身份改变后批准、证据与验收一致失效；阶段写入不使它们失效。

## 8. 本轮决策

- 取消／阻塞／解除／重开历史追加在需求实体中；单文件发布避免另建事件日志或跨文件事务。当前阻塞字段只表示活动阻塞，不代替历史。
- 禁止给旧证据重新绑定身份：只能重新验证；旧批准、方案与验收同样不补造历史。
- 界面同时显示实体修订与内容修订；未升级数据明确标示旧修订规则。
- 宿主与 omp 必须一起更新。源端未知版本或不支持的实体结构拒绝，不退化为绕过授权的发送。
- 生命周期操作不能终止进程。有运行或待核对操作时拒绝，先在原操作中停止调度／核对结果，再明确转换。

具体实现、检查结果与未完成桌面场景见实施计划的 R4b 记录。

## 9. 实施与验证记录

2026-11-13，WSL2、Lune 0.11.1、Bun 1.3.14、Tern 0.9.18。没有新增依赖，没有修改模型、Provider 或日常会话配置。

| 检查 | 实际结果 | 范围 |
| --- | --- | --- |
| `/tmp/lune-bin/lune run tests/run-validity.luau` | 86 checks，0 failures | 内容／实体修订、A→B→A、防止旧授权复活、覆盖与门禁一致 |
| `/tmp/lune-bin/lune run tests/run-store-lifecycle.luau` | 165 checks，0 failures | 生产 Store API；隔离内存 FS/CAS，旧读新写、冲突、失败、历史上限、旧阻塞字段保留 |
| `/tmp/lune-bin/lune run tests/run-content-identity.luau` | 27 checks，0 failures | 生产 workflow/results/review 读写；内存发布器，旧条目不回填，新证据／决定保留身份 |
| `/tmp/lune-bin/lune run tests/run-host.luau` | 121 checks，0 failures | 生命周期事件、原因草稿、忙碌门禁、验证冻结归属与超时；受控异步边界，不是真实验证进程 |
| `/tmp/lune-bin/lune run tests/run-views.luau` | 1228 checks，0 failures | 视图输出与动作契约，不是像素或输入证据 |
| `bun test omp/handoff.test.ts` | 21 pass，0 fail，95 expects | 隔离 Git/文件上的真实源端授权、schema 1/2、漂移和意图核对 |
| Tern `shot` 中分 7 次 `carly lua` 驱动 `tests/workflow.luau` | 全阶段完成，逐阶段断言无失败 | 真正的 Tern FS、PowerShell SHA-256、锁、CAS、不可变方案、批准／回执／阶段写入；无模型提示 |

原生场景的最终命令为 `tern shot <临时场景> --out <repo>/target/r4b-native --theme light --size 1100x900`。场景调用测试返回的状态函数，每次原生调用推进一个 phase；最初误调用模块工厂及单次调用超过 Carly 1000ms CPU 限额的尝试失败，修正驱动方式后通过，未改变产品门禁。原生输出存于 `target/r4b-native/workbench-r4b-native/`，测试存储副本存于 `target/r4b-native/workflow-store/`；临时脚本／工程清理，不留下自动运行入口。

宿主新增异步测试首次被既有夹具的 `nextNumber=2`（已有 REQ-0003）阻止，修正夹具为 4 后通过；没有放宽项目完整性校验。

原生工作台视觉检查尝试未完成：隔离 `shot` 进程未加载 `multi-model-workbench.live`，`new_block` 返回空，场景明确失败。未为截图修改用户插件安装／全局配置。原生工作流产物**不**算重设计界面验收；V04-V09/V13/V14 的真实窗口交互、窄宽度、中文 IME、旧二进制完整回滚与断电恢复仍需单独执行。

## 10. 原生生命周期／混合版本验收

2026-11-13，Tern `0.9.18 (6f1fa0f)`，Windows 原生 FS／PowerShell writer，WSL 隔离工程。新增可复用 `tests/native-lifecycle.luau`；每次原生 Lua 调用推进一个 phase，避免累计 CPU 限额。没有替换 FS／CAS 发布器，也没有执行模型请求。

- 执行：`tern shot <临时 scenario.txt> --out <repo>/target/r4b-acceptance --theme light --size 1100x900`。
- 驱动：加载模块后传入 `(tern, repo, tempRoot, oldStoreSource, waitOne)`；`waitOne(x)` 等待实际 awaitable，无参数时等待 `tern.sleep(1)`；连续调用返回的状态函数 7 次，每次断言 failures 为空，末次断言 done。
- 旧读取器：从提交 `d4cacc8` 提取 `lib/store.luau`，不是推测旧行为，也不将它等同于完整旧二进制。
- 结果：**20 checks，0 failures，phase 7**。原始结果、工程存储副本和渲染器输出保存在 `target/r4b-acceptance/`。临时驱动、旧代码副本和临时工程已清理。

| 场景 | 实际观察 |
| --- | --- |
| schema 1 首次生命周期写入 | 原生 CAS 升为 2，实体修订 7→8，内容修订保持 7 |
| 阻塞 CAS 成功后丢弃回调 | 重新读取恢复已提交状态；旧修订重复操作被拒绝，历史仍只有一条 |
| 解除／取消／重开 | 回到原阶段／cancelled／clarifying；完整四条历史、中文原因与原阻塞原因保留，内容修订不变 |
| 未知 schema 3 | 读取报告错误，生命周期写入拒绝，原始字节不变 |
| v1/v2 混合工程 | 两项需求可读，读取不触发升级或重置 |
| 旧版读取器遇到 v2 | 报告不兼容，原始文件不被改写 |

边界：只模拟**成功落盘后的回调丢失**，没有模拟断电、磁盘损坏或跨文件完整备份回滚。没有证明旧二进制的所有写入口都安全。上述结果不关闭完整 V13，也不替代桌面 V14。

### 仍待真实窗口操作

使用隔离测试工程，不在日常需求上取消／重开：

1. 分别在 360／492／800 逻辑像素宽度打开生命周期确认面板，检查原因输入、完整错误与确认／取消按钮可用。
2. 用中文 IME 连续输入、多行编辑、撤销；切换需求再切回、重载面板，确认草稿不丢失、不串需求、不误提交。
3. 空原因不得转换；确认后历史保留原因；阻塞解除返回原阶段；取消不显示“进程已终止”；重开不自动批准。
4. 在来源忙碌、验证运行、待核对投递期间尝试转换，确认被拒绝；查看／关闭面板不改变修订。

当前真实窗口中存在用户日常工程的工作台，本轮只读取窗口清单，未切换或操作该工程。上一轮隔离渲染器没有加载工作台插件的问题仍在；没有为取得截图修改用户安装。中文 IME 的真实组合输入需要 Windows 交互环境完成，状态保持未验收。
