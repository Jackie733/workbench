import { useRef } from "react";
import { ArrowUp, Folder, Lightbulb, Pencil, RefreshCw } from "lucide-react";
import type { PrivacyMode } from "../../core/types.ts";
import {
  HARNESS_IDS,
  ROUTING_STAGES,
  type HarnessId,
  type ReasoningEffort,
  type RoutingPreset,
  type RoutingStage,
} from "../../hub/types.ts";
import { api, setApiProjectScope } from "../api.ts";
import {
  invalidateAllWorkbenchQueries,
  queryClient,
  queryKeys,
  runBusy,
  submitAnnotation,
  submitFeedback,
  submitLifecycle,
  submitNewRequirement,
  useHubStateQuery,
  useProjectQuery,
  useRequirementQuery,
} from "../queries.ts";
import { EFFORT_LABELS, supportedEffortsForModel } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";
import { MarkdownView, ModalShell } from "./Primitives.tsx";

const STAGE_LABEL: Record<RoutingStage, string> = {
  design: "规划与方案设计 (design)",
  implement: "编码实现 (implement)",
  fix: "失败诊断与修复 (fix)",
  review: "交付前交叉审查 (review)",
};

const PRESET_INFO: Array<{ id: RoutingPreset; name: string; desc: string }> = [
  { id: "balanced", name: "性价比均衡 (推荐)", desc: "Codex/AGY 规划与审查，QoderCN/OpenCode 承担高频编码" },
  { id: "sota_first", name: "SOTA 攻坚优先", desc: "关键阶段全线优先调用高推理主力模型" },
  { id: "quota_saver", name: "极致省流保额", desc: "最大化使用 QoderCN 与 OpenCode 免费模型保留 SOTA 额度" },
];

export function Modals() {
  const m = useUiStore((s) => s.modal);
  const busy = useUiStore((s) => s.busy);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const setModal = useUiStore((s) => s.setModal);
  const showToast = useUiStore((s) => s.showToast);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const setSelectedId = useUiStore((s) => s.setSelectedId);
  const setSelectedDiffFile = useUiStore((s) => s.setSelectedDiffFile);
  const setQuery = useUiStore((s) => s.setQuery);

  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);
  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);

  const fallbackAreaRef = useRef<HTMLTextAreaElement | null>(null);
  if (!m) return null;

  const close = () => setModal(null);
  const bridgeConnected = Boolean(project?.bridge.connected);
  const harnesses = hub?.harnesses ?? [];
  const routing = hub?.routing ?? null;
  const detail = reqData?.detail ?? null;

  if (m.kind === "new_req") {
    return (
      <ModalShell onClose={close} testId="new-req-modal">
        <h3>新建需求</h3>
        <label className="muted" style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
          你想实现或修复什么？
        </label>
        <textarea
          className="textarea"
          id="new-req-goal"
          data-testid="new-req-goal"
          autoFocus
          value={m.goal}
          placeholder="用一句话描述需求目标，细节与验收标准可交给 Agent 整理…"
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "new_req" ? { ...prev, goal: e.target.value } : prev))
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn"
            type="button"
            data-testid="save-draft-btn"
            disabled={busy}
            onClick={() => void submitNewRequirement(m.goal, false, bridgeConnected)}
          >
            仅保存草稿
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="create-and-dispatch-btn"
            disabled={busy}
            onClick={() => void submitNewRequirement(m.goal, true, bridgeConnected)}
          >
            创建并让 Agent 整理方案
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "add_project") {
    const browse = m.browse;
    const browseDir = async (targetPath: string) => {
      try {
        const next = await api.browseFs(targetPath);
        setModal((prev) =>
          prev?.kind === "add_project" ? { ...prev, browse: next, pathInput: next.currentPath } : prev,
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : "无法打开目录", true);
      }
    };

    const submitAddProject = async () => {
      const rootPath = m.pathInput.trim();
      if (!rootPath) {
        showToast("请输入或选择项目目录路径", true);
        return;
      }
      const res = await runBusy(async () => {
        const out = await api.addHubProject({
          root: rootPath,
          name: m.nameInput.trim() || undefined,
          initPrivacy: m.initPrivacy === "none" ? undefined : m.initPrivacy,
        });
        setApiProjectScope(out.project.id);
        setModal(null);
        setActiveProjectId(out.project.id);
        setSelectedId(null);
        setSelectedDiffFile(null);
        setQuery("");
        return out;
      });
      if (res) {
        await invalidateAllWorkbenchQueries();
        showToast(`已切换到项目 ${res.project.name}`);
      }
    };

    return (
      <ModalShell onClose={close} wide testId="add-project-modal">
        <h3>添加或切换本地项目目录</h3>
        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
          项目根目录路径（支持手动输入或下方点击浏览）
        </label>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            className="input"
            id="add-project-path"
            data-testid="add-project-path"
            autoFocus
            value={m.pathInput}
            placeholder="/home/jackie/code/your-project"
            onChange={(e) =>
              setModal((prev) => (prev?.kind === "add_project" ? { ...prev, pathInput: e.target.value } : prev))
            }
          />
          <button
            className="btn"
            type="button"
            data-testid="browse-go-btn"
            onClick={() => void browseDir(m.pathInput)}
          >
            打开目录
          </button>
        </div>
        <div className="browse-box" data-testid="fs-browse-list">
          {browse ? (
            <>
              <div className="browse-head">
                <span className="xs muted">{browse.currentPath}</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {browse.isGitRepo ? (
                    <span className="badge success">Git 仓库</span>
                  ) : (
                    <span className="badge neutral">普通目录</span>
                  )}
                  {browse.workbenchInitialized && <span className="badge info">已初始化</span>}
                  {browse.parentPath && (
                    <button
                      className="btn ghost xs"
                      type="button"
                      onClick={() => void browseDir(browse.parentPath!)}
                    >
                      <Icon icon={ArrowUp} size={14} /> 上级目录
                    </button>
                  )}
                </div>
              </div>
              <div className="browse-entries">
                {browse.entries.length === 0 ? (
                  <div className="muted xs" style={{ padding: 10 }}>
                    无子目录
                  </div>
                ) : (
                  browse.entries.map((e) => (
                    <div key={e.path} className="browse-entry" onClick={() => void browseDir(e.path)}>
                      <span className="browse-entry-name">
                        <Icon icon={Folder} size={14} /> {e.name}
                      </span>
                      <span style={{ display: "flex", gap: 6 }}>
                        {e.isGitRepo && <span className="badge success">git</span>}
                        {e.workbenchInitialized && <span className="badge info">wb</span>}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="muted xs" style={{ padding: 12 }}>
              正在读取本地目录…
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              显示名称（可选）
            </label>
            <input
              className="input"
              id="add-project-name"
              value={m.nameInput}
              placeholder="默认取文件夹名"
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "add_project" ? { ...prev, nameInput: e.target.value } : prev))
              }
            />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              .workbench/ 初始化策略
            </label>
            <select
              className="select"
              id="add-project-privacy"
              style={{ width: "100%" }}
              value={m.initPrivacy}
              onChange={(e) =>
                setModal((prev) =>
                  prev?.kind === "add_project"
                    ? { ...prev, initPrivacy: e.target.value as PrivacyMode | "none" }
                    : prev,
                )
              }
            >
              <option value="local">自动初始化（仅本机 .git/info/exclude）</option>
              <option value="tracked">自动初始化（随仓库 Git 跟踪）</option>
              <option value="none">仅加入列表，稍后手动初始化</option>
            </select>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-add-project-btn"
            disabled={busy}
            onClick={() => void submitAddProject()}
          >
            添加并切换到此项目
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "routing") {
    const cfg = m.draft ?? routing;

    const refreshHarnesses = async () => {
      const res = await runBusy(() => api.refreshHarnesses());
      if (res) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
        showToast("已刷新本机 CLI 与模型列表");
      }
    };

    const applyPreset = async (preset: RoutingPreset) => {
      const res = await runBusy(() => api.applyPreset(preset));
      if (res) {
        setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: res.routing } : prev));
        await queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
        showToast(`已应用策略预设：${preset}`);
      }
    };

    const addCustomModel = async () => {
      const modelId = m.customModel.trim();
      if (!modelId) {
        showToast("请输入模型 ID", true);
        return;
      }
      const res = await runBusy(() => api.addCustomModel(m.customHarness, modelId));
      if (res) {
        setModal((prev) => (prev?.kind === "routing" ? { ...prev, customModel: "" } : prev));
        await queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
        showToast(`已添加模型 ${modelId}`);
      }
    };

    const saveRouting = async () => {
      if (!cfg) return;
      const res = await runBusy(() => api.saveRouting(cfg));
      if (res) {
        setModal(null);
        await queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
        showToast("模型路由配置已保存");
      }
    };

    return (
      <ModalShell onClose={close} wide testId="routing-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>算力探测与分阶段模型路由中心</h3>
          <button
            className="btn xs"
            type="button"
            data-testid="refresh-harnesses-btn"
            disabled={busy}
            onClick={() => void refreshHarnesses()}
          >
            <Icon icon={RefreshCw} size={14} /> 重新探测本机模型
          </button>
        </div>

        <div className="preset-grid" data-testid="routing-presets">
          {PRESET_INFO.map((p) => (
            <button
              key={p.id}
              className={`preset-card ${cfg?.activePreset === p.id ? "active" : ""}`}
              type="button"
              data-testid={`preset-${p.id}`}
              onClick={() => void applyPreset(p.id)}
            >
              <strong>{p.name}</strong>
              <div className="xs muted" style={{ marginTop: 4 }}>
                {p.desc}
              </div>
            </button>
          ))}
        </div>

        {cfg && (
          <div className="routing-table" style={{ marginTop: 12 }}>
            {ROUTING_STAGES.map((stg) => {
              const rule = cfg.stages[stg];
              const selectedVal = `${rule.primary.harness}::${rule.primary.model}`;
              const customInList = harnesses.some(
                (h) => h.id === rule.primary.harness && h.models.some((x) => x.id === rule.primary.model),
              );
              const efforts = supportedEffortsForModel(harnesses, rule.primary.harness, rule.primary.model);

              return (
                <div key={stg} className="routing-row">
                  <div className="min-w-0">
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{STAGE_LABEL[stg]}</div>
                    <div className="xs muted truncate">
                      备援：{rule.fallbacks.map((f) => `${f.harness}/${f.model}`).join(" → ") || "无"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      className="select min-w-[230px]"
                      data-testid={`route-select-${stg}`}
                      value={selectedVal}
                      onChange={(e) => {
                        const [harness, model] = e.target.value.split("::");
                        if (!harness || !model || !cfg) return;
                        const nextEfforts = supportedEffortsForModel(harnesses, harness, model);
                        const keepEffort =
                          rule.primary.reasoningEffort && nextEfforts.includes(rule.primary.reasoningEffort)
                            ? rule.primary.reasoningEffort
                            : undefined;
                        const nextCfg = {
                          ...cfg,
                          stages: {
                            ...cfg.stages,
                            [stg]: {
                              ...cfg.stages[stg],
                              primary: {
                                harness: harness as HarnessId,
                                model,
                                ...(keepEffort ? { reasoningEffort: keepEffort } : {}),
                              },
                            },
                          },
                        };
                        setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: nextCfg } : prev));
                      }}
                    >
                      {!customInList && (
                        <option value={selectedVal}>
                          {rule.primary.harness} · {rule.primary.model}
                        </option>
                      )}
                      {harnesses.map((h) => (
                        <optgroup key={h.id} label={`${h.label} (${h.installed ? h.subscription : "未安装"})`}>
                          {h.models.map((mod) => {
                            const val = `${h.id}::${mod.id}`;
                            return (
                              <option key={val} value={val}>
                                {h.id} · {mod.id}
                                {mod.source === "custom" ? " [自定义]" : ""}
                              </option>
                            );
                          })}
                        </optgroup>
                      ))}
                    </select>
                    <select
                      className="select font-mono w-[135px]"
                      data-testid={`route-effort-${stg}`}
                      title="该阶段推理强度 (Reasoning Effort)"
                      value={rule.primary.reasoningEffort ?? ""}
                      onChange={(e) => {
                        const eff = e.target.value as ReasoningEffort | "";
                        const nextPrimary = { ...rule.primary };
                        if (eff) nextPrimary.reasoningEffort = eff;
                        else delete nextPrimary.reasoningEffort;
                        const nextCfg = {
                          ...cfg,
                          stages: {
                            ...cfg.stages,
                            [stg]: { ...cfg.stages[stg], primary: nextPrimary },
                          },
                        };
                        setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: nextCfg } : prev));
                      }}
                    >
                      <option value="">默认强度</option>
                      {efforts.map((eff) => (
                        <option key={eff} value={eff}>
                          {EFFORT_LABELS[eff] ?? eff}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="custom-model-bar">
          <strong className="xs">补充自定义模型（如 OpenCode Go 付费模型 ID）：</strong>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <select
              className="select"
              id="custom-model-harness"
              style={{ width: 140 }}
              value={m.customHarness}
              onChange={(e) =>
                setModal((prev) =>
                  prev?.kind === "routing" ? { ...prev, customHarness: e.target.value as HarnessId } : prev,
                )
              }
            >
              {HARNESS_IDS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <input
              className="input"
              id="custom-model-id"
              data-testid="custom-model-input"
              value={m.customModel}
              placeholder="例如 opencode-go/claude-sonnet-4.6"
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "routing" ? { ...prev, customModel: e.target.value } : prev))
              }
            />
            <button
              className="btn"
              type="button"
              data-testid="add-custom-model-btn"
              onClick={() => void addCustomModel()}
            >
              添加模型
            </button>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="save-routing-btn"
            disabled={busy}
            onClick={() => void saveRouting()}
          >
            保存路由配置
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "annotate_anchor") {
    return (
      <ModalShell onClose={close} testId="annotate-modal">
        <h3>段落批注与提问</h3>
        <div className="xs muted" style={{ marginBottom: 8 }}>
          锚点位置：<span className="badge info">{m.anchor}</span>
        </div>
        <textarea
          className="textarea"
          id="annotate-msg"
          data-testid="annotate-msg"
          autoFocus
          value={m.message}
          placeholder="输入对该段落的疑问（仅探讨）或修改意见（将汇总至待提交批注列表）…"
          onChange={(e) =>
            setModal((prev) =>
              prev?.kind === "annotate_anchor" ? { ...prev, message: e.target.value } : prev,
            )
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn"
            type="button"
            data-testid="annotate-ask-btn"
            onClick={() => detail && void submitAnnotation(detail.state.id, m.anchor, m.message, "ask")}
          >
            <Icon icon={Lightbulb} size={14} /> 加入并立即提问
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="annotate-queue-btn"
            onClick={() => detail && void submitAnnotation(detail.state.id, m.anchor, m.message, "refine")}
          >
            <Icon icon={Pencil} size={14} /> 加入待修订批注
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "handoff_preview") {
    return (
      <ModalShell onClose={close} wide testId="handoff-modal">
        <h3>跨模型上下文交接简报（handoff.md）</h3>
        <p className="xs muted" style={{ margin: "0 0 10px" }}>
          切换 Harness 或异常重跑时，工作台自动合成以下高信噪比现场简报喂给下一个模型（不含冗长探索废话）：
        </p>
        <div className="handoff-preview-box">
          <MarkdownView markdown={m.markdown} />
        </div>
        <div className="modal-actions">
          <button className="btn primary" type="button" onClick={close}>
            关闭
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "feedback") {
    return (
      <ModalShell onClose={close}>
        <h3>提出修改意见</h3>
        <textarea
          className="textarea"
          id="feedback-input"
          autoFocus
          value={m.feedback}
          placeholder="清晰写下需要调整的规范、方案或修复问题…"
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "feedback" ? { ...prev, feedback: e.target.value } : prev))
          }
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 13 }}>
          <input
            type="checkbox"
            id="feedback-dispatch"
            checked={m.dispatchAgent}
            onChange={(e) =>
              setModal((prev) =>
                prev?.kind === "feedback" ? { ...prev, dispatchAgent: e.target.checked } : prev,
              )
            }
          />
          <span>退回后同步投递修改指令给当前模型 / 终端会话</span>
        </label>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={() => detail && void submitFeedback(detail, m.feedback, m.dispatchAgent)}
          >
            确认退回修改
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "lifecycle") {
    const title = m.action === "block" ? "标记需求阻塞" : m.action === "cancel" ? "取消需求" : "重新打开需求";
    return (
      <ModalShell onClose={close}>
        <h3>{title}</h3>
        <textarea
          className="textarea"
          id="lifecycle-reason"
          autoFocus
          value={m.reason}
          placeholder="请说明原因…"
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "lifecycle" ? { ...prev, reason: e.target.value } : prev))
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={() => detail && void submitLifecycle(detail, m.action, m.reason)}
          >
            确认
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "prompt_fallback") {
    const copyPrompt = async () => {
      try {
        await navigator.clipboard.writeText(m.prompt);
        showToast("已复制到剪贴板");
      } catch {
        fallbackAreaRef.current?.select();
        showToast("请按 Ctrl+C 复制选中文本");
      }
    };

    return (
      <ModalShell onClose={close} testId="prompt-fallback-modal">
        <h3>{m.title}</h3>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          {m.subtitle}
        </p>
        <textarea
          ref={fallbackAreaRef}
          className="textarea"
          id="fallback-prompt-text"
          readOnly
          style={{ minHeight: 170, fontFamily: "var(--mono)", fontSize: 12 }}
          value={m.prompt}
        />
        <div className="modal-actions">
          <button className="btn" type="button" data-action="close-modal" onClick={close}>
            关闭
          </button>
          <button className="btn primary" type="button" onClick={() => void copyPrompt()}>
            复制指令
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={close}>
      <h3>调试信息</h3>
      <pre className="evidence-log">{m.text}</pre>
      <div className="modal-actions">
        <button className="btn primary" type="button" onClick={close}>
          关闭
        </button>
      </div>
    </ModalShell>
  );
}
