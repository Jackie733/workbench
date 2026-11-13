# R3a：验证命令准备与条件覆盖

- 日期：2026-11-13
- 状态：已实施，自动回归通过。真实 Tern 桌面只做了设计，未执行；R3b（串行批量）因 E4 未批准而不包含。
- 依据：[重设计提案](REDESIGN_PROPOSAL.md) §6.2、[实施计划](REDESIGN_IMPLEMENTATION_PLAN.md) R3a。

## 1. 交付范围

| 内容 | 位置 |
| --- | --- |
| 只读命令发现：package.json 脚本、Makefile 目标、Cargo.toml／go.mod／mix.exs 固定测试命令、历史证据命令 | `host.luau#discoverCandidates` |
| 候选只是草稿：填入命令框，仍需预览与确认 | `host.luau` 的 `results-use-candidate=`、Delivery 页 |
| 验证预览：确切命令、项目根目录、发行版、`bash -lc`、180 秒超时、关联条件 | `lib/runview.luau`、`host.luau#results-preview-verification` |
| 预览匹配才允许运行；命令或条件变化后必须重新预览 | `host.luau#results-run-verification` |
| 验收条件覆盖矩阵：必需／信息性分开，逐项状态与当前快照关系 | `lib/runview.luau`，数据来自 `Validity.criteria` |
| 既有执行路径保持不变 | `host.luau#startTraceVerification` |

约束：

- 发现过程只读取受限大小的项目清单，不执行命令、不解释脚本正文；没有候选时直接提示手动填写。
- 历史命令只作为草稿来源，历史通过结果不会成为当前证据（有效性仍由 `Validity.verification` 判定）。
- 改变验收条件的必需／信息性属于需求编辑，沿用现有内容摘要与批准失效规则；界面不提供“静默降级”。
- 未实现批量：一次只记录一条验证；E4 决策与批量恢复协议未批准。

## 2. 实际运行

环境：WSL Ubuntu；Lune 0.11.1；Bun 1.3.14。

| 命令 | 结果 |
| --- | --- |
| `lune run tests/run-views.luau` | 1144 checks, 0 failures |
| `lune run tests/run-host.luau` | 73 checks, 0 failures |
| `lune run tests/run-validity.luau` | 64 checks, 0 failures |
| `bun test omp/` | 28 pass, 0 fail |

新增覆盖：

- 从 `package.json` 与 `Makefile` 发现 `npm run test`／`make test`，测试环境的进程写入桩没有被调用（发现不执行任何命令）。
- 未预览时运行被拒绝；预览记录确切命令与条件；预览后修改命令，运行被拒绝并要求重新预览；匹配后进入“先读代码快照”的既有路径。
- 选择候选只填入草稿并清除旧预览。
- 交付页渲染覆盖卡、候选卡、预览卡；命令变化后确认按钮禁用。

## 3. 验收矩阵

| ID | 状态 |
| --- | --- |
| V01 | 覆盖矩阵与验收门禁共用 `Validity.criteria`；本轮回归覆盖必需／信息性分开与快照缺失 |
| V03 | 仍由共享有效性判定；验证后代码变化的失效提示保留，真实 Git 场景未重跑 |
| V10 | 自动覆盖发现不执行、确切预览、预览漂移；含空格／中文目录的实际执行与超时场景仍属既有阶段 4 证据，未在本轮重验 |

## 4. 已知限制

- 命令发现只识别少量常见清单，不做启发式猜测；识别失败的脚本需要手动输入。
- 预览与运行状态不持久化：重载后必须重新预览（这是有意的授权边界）。
- 批量执行、选择性失效与影子实验未开始（R3b／R6，需单独批准）。
