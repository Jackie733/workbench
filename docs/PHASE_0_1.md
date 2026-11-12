# 阶段 0＋1：单会话实时闭环

日期：2026-11-11。实际环境：Windows Tern 0.9.16（41a10a5）、WSL Ubuntu、omp 18.18.7、Bun 1.3.14。

## 范围与交付

阶段 0 已固定 [领域契约](DOMAIN_CONTRACT.md)：实体 schema、生命周期、批准／证据失效、单写者和恢复协议、旧数据迁移映射。正式业务存储、需求池、看板和验收功能仍按后续阶段实施，不因存在协议文档就宣称已经实现。

阶段 1 实现：

- `/wb` 从实际来源 omp 原位打开一个右侧原生工作台；重复打开复用，不创建 omp 或标签页。
- 显示真实模型、会话、状态、工具、原生 todo 计划和有界事件。
- 工作台中文多行资料保存、恢复，以及显式预填到同一 omp 输入框。
- 草稿冲突、忙碌、会话错配、过期请求、重复请求和不确定回执保护。
- 新建、分叉、恢复会话后，旧工作台绑定失效，用户再次 `/wb` 才重新绑定。
- 未知或断开的状态明确标识，不把模型回合、计划完成、工具成功或回复升级为业务验收。

## 激活与使用

Tern 插件本机已链接该仓库，ID 保持 `multi-model-workbench`，版本 3.0.0。

本机添加了轻量扩展发现入口：

```text
~/.omp/agent/extensions/workbench.ts
```

它仅重导出 `/home/jackie/code/workbench/omp/index.ts`，未修改模型、Provider、fallback 或凭据。没有自动重载用户日常 omp。

- 已有 omp：在方便的时候使用原生 `/reload-plugins`，然后 `/wb`。
- 新开发／调试会话：在 Git 项目中运行 `omp --model openai-codex/gpt-6-luna`，然后 `/wb`。这是本次进程覆盖，不是全局默认修改。
- 不依赖本机发现入口时，可显式加载：`omp --extension /absolute/path/to/workbench/omp/index.ts`。不要同时启用两个相同扩展入口；隔离测试使用 `--no-extensions` 加显式 `--extension`。
- 不要在已运行的 omp 内再启动一个 omp 来激活扩展。当前会话保持不动或使用其原生重载。

工作台的“预填到此会话（不发送）”只修改空的 omp 输入框；资料不会自动发送，用户仍需要在 omp 中明确提交。已有文字、空白或附件 chip 都视为草稿，拒绝覆盖。形似图片路径的文本保持字面内容，不触发智能粘贴或加载图片。

关闭右侧工作台不退出左侧 omp；再次 `/wb` 可恢复同一实例／会话的面板资料。切换到另一会话后草稿分区，不把旧需求文字自动带入新上下文。

## 代码职责

| 文件 | 职责 |
| --- | --- |
| `omp/index.ts` | slash、主会话事件、真实状态、原生编辑器预填、结构化观测 |
| `omp/runtime.ts` | 私有目录、原子文件、请求校验、持久认领、防重放、打开回执 |
| `omp/tern.ts` | 枚举实际窗口、精确 title 路由提示、拒绝歧义 |
| `window.luau` | 唯一来源证明、原位布局、面板注册／恢复、来源健康 |
| `host.luau` | 原生中文编辑、状态／计划／事件、预填与打开回执 |
| `lib/live.luau` | 有界 JSON、UNC 规范化、显式操作的异步原子文件写入 |
| `omp/runtime.test.ts` | 消费者边界和身份／回执规则回归 |

旧角色流程的默认窗口代码已经切换，旧 KV 和项目方案未迁移、未删除。其完整迁移与备份仍在阶段 6 执行。

## 实际 IPC v1

目录：`/tmp/omp-workbench-<uid>/<instanceId>/`。扩展检查所有目录为当前用户拥有的 0700 普通目录；扩展写入文件为 0600。Windows 创建的请求／回执受私有父目录保护，不能将所有跨平台文件都宣称为 0600。无 HTTP 服务或额外常驻进程。

### 打开与来源证明

`open.omp-workbench.json`：

```text
schemaVersion=1, instanceId, sessionId, runtimeDir, sourceMarker,
pid, cwd, projectRoot, openRequestId
```

每次 `/wb` 产生全新 `openRequestId`。会话改变会使它失效。

扩展把可见的 `⚒ <项目目录名> · <instanceId 前 8 位>` 放在状态行（原生 dock 的独立文本节点）和 title：只显示项目目录名（不显示完整路径），完整 `instanceId` 仍是协议身份与私有运行目录。不再额外绘制输入框上方的重复行。title 仅为 CLI 路由提示：枚举真实 `clients.kind=window`，逐个显式 window key 检查，匹配不唯一则拒绝。插件仍必须独立读取对应原生 dock，精确证明标记，不能仅凭 title、聊天正文、焦点或目录绑定。若用户关闭状态行 hook 文本（`statusLine.showHookStatus=false`），dock 中不再出现该标记，`/wb` 失败关闭，不退回猜测。

为避免每秒向无关 SSH 窗格发起同步读取，窗口先按精确 title 筛选候选，再读取候选的 dock。没有 title 或 dock 证明均失败关闭，不退回猜测。

Tern 把 WSL 路径规范化为 `\\?\UNC\...`；插件接受该扩展命名空间并规范化，只接受本机 WSL 的指定临时运行目录。CLI 仍通过已安装 WSL 包装器把 Linux marker 路径转为 Windows 路径，不重复套 `wsl.exe`。

**真实发现的边界：** Tern 0.9.16 的 CLI 可以返回 `cannot open in a file block`，但异步 `route.open` 实际已创建原生面板。因此 CLI 退出码不是打开结果。

成功依据是面板在绑定、来源／快照有效并经过首个 view 后原子写入 `opened.json`：

```text
schemaVersion=1, instanceId, sessionId, openRequestId,
sourcePane, panel, window, updatedAt
```

扩展最多等待 8 秒，要求本次 nonce、当前会话、明确窗口／来源 pane 和新鲜时间一致。CLI 返回 0 也不能替代该回执，旧 nonce 不能冒充新打开成功。写失败明确报错，不自动重试。

### 快照与事件

`snapshot.json`：

```text
schemaVersion=1, instanceId, sessionId, pid, cwd, projectRoot,
sourceMarker, updatedAt, sequence, state, model,
currentTool, activeToolCount, recentEvents, plan, lastDelivery, observability
```

- 扩展心跳 750 ms，事件发生时立即发布。
- host worker 每 500 ms 读取有界快照；不在 UI 线程做轮询文件读取，不每次轮询启动进程。
- 来源健康每秒核对；超过 6 秒未更新显示过期，禁止预填。
- 窗口与面板之间的重新绑定、来源健康证明走 `tern.kv` 共享映射，不使用 `session:event`：原生 plugin block 不是外部 TSP 程序，事件通道不作为契约。面板每轮读取按 `window + panel + instance` 限定键。
- 插件重载可能丢失窗口注册表而 block 仍在运行；打开时按真实 panes 收养同源工作台。同 tab 中发现多个本插件 block 时只保留最新 pane 并关闭其余副本，不触碰其他插件或用户 pane。
- `state`：idle、working、waiting_user、disconnected。
- 工具按 toolCallId 管理并行活动，当前显示最后一个尚未结束的工具。
- 最多 80 个事件；事件有独立来源序号。输入参数、命令正文、工具输出、用户 prompt、assistant 正文不复制到运行事件。
- 原生 Bash 明确提供数字退出码时记录；不从 `isError=false` 推断 0，不自动分类为测试通过。
- 原生 ask、工具审批和计划审阅反映等待用户；并不声称能观察任意第三方扩展弹窗。
- 原生 todo 结构化 phases 生成稳定步骤身份和计数；非结构化自然语言不猜进度，归属为 null。eval 内间接更新等没有触发原生工具事件的路径可能需重建分支后才可观测。
- lastDelivery 只是 assistant_candidate 的字节数／时间等元数据，不等于正式方案、验证或验收。

文件快照与 marker 分别原子更新，不是跨文件事务；消费端必须验证身份一致。阶段 1 不把运行事件当作正式业务审计。

### 预填命令与回执

`commands/<requestId>.json`：

```text
schemaVersion=1, requestId, instanceId, sessionId,
kind=prefill, text, createdAt, expiresAt
```

只支持预填，不存在 submit、执行 shell 或切换模型的命令类型。

- 正文 UTF-8 最多 16 KiB，文件最多 32 KiB；拒绝空正文、ESC／危险控制字符、非法 UTF-8、符号链接和非普通文件。
- 生命周期最多 30 秒；未来创建、到期、实例／会话不符均拒绝。
- 每次消费重新读取真实 SDK 身份，检查空闲、无排队输入、无活动工具／已知等待、无计划审阅以及空编辑器。
- 先持久写入 `delivery_unknown/applying_prefill` 认领，再做最后一次检查和同步 `setEditorText`；不调用智能粘贴或按 Enter。
- 任何已有回执都阻止同请求重放；未知结果不自动重试，新进程不扫描旧消息盒。

`receipts/<requestId>.json`：schemaVersion、requestId、instanceId、sessionId、status、reason、updatedAt。status 为 prefilled、rejected 或 delivery_unknown。

host 先保存待投递意图，显式点击时才通过一次异步 PowerShell 原子写入。文本作为 base64 环境数据传输，不拼进脚本。未知请求在有效期结束后可由用户核对输入框并“解除待确认”；只解锁、保留记录，不重发。

## 本轮已执行的验证

自动检查：`bun test omp/runtime.test.ts`，9 通过、0 失败、51 个断言。覆盖 UTF-8 字节上限、控制字符、身份／会话错配、时间边界、草稿／附件 chip、忙碌／计划审阅、文件类型／符号链接、结构化计划身份、候选交付不泄露正文、打开 nonce／窗口／pane 校验和精确窗口候选。

真实桌面验证在独立控制窗口和临时 Git 项目 `/tmp/workbench-phase1-smoke.DpKksx/中文 项目` 中进行，不向日常会话提交测试任务：

- 实际 `/wb` 在原 tab 内只形成源 omp＋右侧工作台；重复打开不增加 pane。
- 真正的 nonce 打开回执与源 session、窗口、pane 一致；修复 CLI 假阴性。
- 中文、emoji、多行和 `.png` 路径文字精确预填，源仍空闲、没有触发推理。
- 再次预填产生 draft_conflict，原草稿不变。
- 插件重载保留中文草稿和同一面板，不调用模型。
- `/new` 改变真实 session；旧会话请求得到 identity_mismatch，新输入框保持空；再次 `/wb` 复用原面板。
- 对“已持久认领、结果未知”进行故障注入，真实消费者删除重复命令但不再预填，原未知回执保留。
- 暂停测试进程超过心跳期限，面板明确显示连接过期并禁用预填；恢复进程后心跳继续。
- 已保存的真实测试会话成功 `/fork` 得到新 ID，再 `/resume <原 ID>` 恢复原始身份；新身份须重新 `/wb`。
- 重载丢失注册表后再次 `/wb`，真实 pane 被收养且两个遗留同名面板收敛为一个，未创建新 omp。
- 共享映射健康证明下，面板持续显示空闲而非误报“来源证明断开”；关闭来源后显示断开／退出并禁用预填。
- 用户要求后，实际模型验收改用 `openai-codex/gpt-6-luna`：原生 todo、Bash 明确 exit 7、ask 等待、确认后 todo 2/2、回复 DONE，最终 idle；回复仍是无需求归属的候选交付。随后该账号触发 Codex usage limit，失败回合被如实显示为 agent 结束而非任务完成；配额不属于本插件的通过标准。

截图位于本机忽略的 `target/shots/tern/live/`。其中开发中截图可能包含已修复错误；仅将最终验证记录与对应阶段使用，不把旧截图当作最终交付状态。

未宣称：正式需求交付闭环、真实业务代码修改的验收、跨平台全面兼容、第三方任意弹窗观测、强制中断全部后台工作、计费余额正确性或不可篡改审计。同步周期已配置，未进行完整延迟分布测量。
