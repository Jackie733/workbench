# Workbench 编排减法与 Agent 能力释放方案（已落地 5 大支柱）

> 原则：**守住核心确定性门禁**（CAS 并发控制、原子写盘、验证证据绑定 `specHash` + `codeSnapshotHash`、人类独占 `approve` / `fast_track` / `accept`），拿掉扼杀 Agent 自主判断、信息保真度与推理强度的冗余控制与人工限制，把原生态工具能力还给 Agent。

---

## 1. 五大核心改造支柱

| 支柱 | 消除的过度设计 / 钳制 | 已落地架构与代码位置 |
| :--- | :--- | :--- |
| **1. 原生上下文（去“中间人”截断）** | 不再把 `spec.md`、`design.md` 与 `git diff` 预切片压缩进 `handoff.md`；消除会随章节有无发生偏移的数字小节编号（`## 0.` / `## 1.` / `## 4.`）。 | `src/hub/handoff.ts` 缩减至 `HANDOFF_MAX_BYTES = 8 * 1024`，转为 **pointer-first**（直接指引 `spec.md`、`design.md`、`evidence/` 等磁盘权威路径与 `baseline.head`），使用固定语义标题；`src/hub/prompt.ts` 作为唯一提示词构建入口，由 `src/server/prompts.ts` 薄包装复用。 |
| **2. 宿主驱动状态流转 + 文件原生设计（去“填表行政”）** | 废除设计阶段禁止只读检查/复现的限制，废除“必须记住调用 `wb propose` / `wb tasks` / `--ready` 否则卡死流转”的心智负担；清理 `prompts.ts` 与 `executor.ts` 两套割裂的“严禁”微管理条款与重复语言指令。 | `src/hub/prompt.ts` + `src/hub/executor.ts`：`design` 允许只读复现排查并直接编辑磁盘 `spec.md` / `design.md` / `criteria.json`，退出码 0 后由宿主自动通过 `propose()` 同步并迁移至 `awaiting_approval`（含 Worktree 沙箱双向镜像）；`implement` / `fix` 退出码 0 且代码有变更时，宿主自动执行 `runAllVerifications()`，全部通过自动进入 `awaiting_acceptance`，失败则自动拉起原会话 `fix`（`dispatchReason: "auto_heal"`，`MAX_AUTO_HEAL_ATTEMPTS = 2`）。 |
| **3. 单轮独立盲审 + 确定性作弊信号（去“多轮挑刺乒乓”）** | 移除多轮增量审查收敛提示与 `block` 时默认 `+1` 轮次自动放大，避免审查者迎合历史结论；不再把 Playbook 偏见注入评审；提示词改为鼓励复用匹配快照证据。 | `src/hub/executor.ts` + `src/hub/types.ts` + `src/hub/handoff.ts` + `src/web/components/Modals.tsx`：`maxAutoReviewRounds` 默认降为 `1` 且移除 `block` `+1` 放大；自动审查优先选择与实施者不同的可运行 Harness；`review` 模式隔离 Playbook 与增量审查帧；`src/core/validity.ts`（`detectTestTamperingSignals`）与 `src/core/engine.ts`（`getRequirementDiff`）在代码层确定性检测删除测试文件、新增 `.skip`/`.only`/`#[ignore]` 及净删断言并提示。 |
| **4. 取消强制降智与强制失忆（保留满血算力与连续现场）** | 移除 `balanced` / `quota_saver` 预设与 `desiredEffortForStage` 中的强制 `reasoningEffort: "low"`；取消 `fix` 强制切换低阶模型；移除 `MAX_RESUME_CONTEXT_TOKENS = 100_000` 与 `MAX_CONSECUTIVE_NATIVE_RESUMES = 2` 强制清空长会话的硬上限。 | `src/hub/routing.ts` + `src/hub/executor.ts`：`fix` 与 `implement` 共用同等级静态路由与评分策略；保留 `fix` 会话亲和性——只要前序编码运行未被取消、限流或模型不可用，即使曾失败/超时或上下文较长，仍优先同模型同会话 `native_resume`。 |
| **5. 停止隐式 L1 Playbook 污染（仅保留显式沉淀）** | 移除人类点击 `accept` 时静默向项目 `playbook.md` 自动蒸馏并全局注入所有后续提示词的隐式链路。 | `src/server/project_api.ts`：移除了 `POST /api/requirements/:id/accept` 中的自动 `distillRequirementToPlaybook` 调用，保留显式 `/api/project/playbook/distill` 接口以及 L2 遥测冷却路由、L3/L4 痛点演化与 Worktree 沙箱能力。 |

---

## 2. 守住的核心红线（未做丝毫妥协）

1. **`DOMAIN_CONTRACT.md` 第 3.1–3.4 节不变量完整保留**：CAS 版本锁、原子写盘与 `history/` 快照、验证证据严格绑定 `specHash` + `codeSnapshotHash`、`approve` / `fast_track` / `accept` 始终只能由人类在工作台或审批 CLI 触发。
2. **`isNonBreakingCriteriaUpdate` 防篡改不变量保留**：Agent 仅可非破坏性补充方案与新增验收条件；若企图修改或放宽已审批必需验收条件 `command` 或 `required` 标志，仍会立即撤销审批要求人类重新批准。
3. **跨进程并发与沙箱隔离保留**：验证单项目锁、Git Worktree 沙箱与 `syncRequirementMirrorToSandbox` 同步均保持严格隔离。

---

## 3. 验证与文件索引

- 提示词统一入口：[prompt.ts](../src/hub/prompt.ts)、[prompts.ts](../src/server/prompts.ts)
- 交接简报与盲审隔离：[handoff.ts](../src/hub/handoff.ts)
- 宿主自愈与自动验收闭环：[executor.ts](../src/hub/executor.ts)
- 路由去降智与会话统一：[routing.ts](../src/hub/routing.ts)
- 确定性测试篡改信号检测：[validity.ts](../src/core/validity.ts)、[engine.ts](../src/core/engine.ts)
- 显式 Playbook 边界与 UI 默认值：[project_api.ts](../src/server/project_api.ts)、[Modals.tsx](../src/web/components/Modals.tsx)
- 专项自动化测试：[agent_autonomy.test.ts](../tests/hub/agent_autonomy.test.ts)、[run_guards.test.ts](../tests/hub/run_guards.test.ts)、[review_workflow.test.ts](../tests/hub/review_workflow.test.ts)、[engine.test.ts](../tests/core/engine.test.ts)
