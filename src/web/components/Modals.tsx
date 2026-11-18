import { useRef } from "react";
import {
  ArrowUp,
  Check,
  Crosshair,
  ExternalLink,
  Flame,
  Folder,
  GitPullRequest,
  Globe,
  Laptop,
  Lightbulb,
  Link2,
  Pencil,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import type { OutputLanguage, PrivacyMode } from "../../core/types.ts";
import type { PainPointCategory } from "../../hub/evolution.ts";
import {
  ROUTING_STAGES,
  type HarnessId,
  type ReasoningEffort,
  type RoutingPreset,
  type RoutingStage,
} from "../../hub/types.ts";
import { api, evolutionAttachmentUrl, setApiProjectScope, type HubStateResponse } from "../api.ts";
import {
  invalidateAllWorkbenchQueries,
  openRequirement,
  queryClient,
  queryKeys,
  runBusy,
  submitAnnotation,
  submitFeedback,
  submitImportGitHubIssue,
  submitLifecycle,
  submitNewRequirement,
  useDeliveryQuery,
  useEvolutionQuery,
  useGitHubStatusQuery,
  useHubStateQuery,
  usePlaybookQuery,
  useProjectQuery,
  useRequirementQuery,
} from "../queries.ts";
import { EFFORT_LABELS, formatDateTime, parseRunnerKey, supportedEffortsForModel } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { AttachmentGallery } from "./AttachmentGallery.tsx";
import { AttachmentPicker } from "./AttachmentPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownView, ModalShell } from "./Primitives.tsx";

const STAGE_LABEL: Record<RoutingStage, string> = {
  design: "规划与方案设计 (design)",
  implement: "编码实现 (implement)",
  fix: "失败诊断与修复 (fix)",
  review: "交付前交叉审查 (review)",
};

const PRESET_INFO: Array<{ id: RoutingPreset; name: string; desc: string }> = [
  { id: "balanced", name: "性价比均衡 (推荐)", desc: "规划与审查用强推理模型把关，高频编码交给大额度主力，质量与成本兼顾" },
  { id: "sota_first", name: "SOTA 攻坚优先", desc: "四个阶段全线优先最强推理模型，追求质量上限，额度消耗最高" },
  { id: "quota_saver", name: "极致省流保额", desc: "优先使用免费与高性价比模型，最大限度保留付费旗舰额度" },
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
  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const { data: project } = useProjectQuery(activeProjectId);
  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);
  const { data: evolutionData } = useEvolutionQuery(m?.kind === "evolution");
  const { data: playbookData } = usePlaybookQuery(
    activeProjectId,
    m?.kind === "evolution" && m.tab === "playbook" && !noHubProject,
  );
  const { data: deliveryPreview } = useDeliveryQuery(
    activeProjectId,
    selectedId,
    Boolean(selectedId && m?.kind === "deliver"),
  );
  const { data: githubStatus } = useGitHubStatusQuery(
    activeProjectId,
    Boolean(
      !noHubProject &&
        project?.initialized &&
        m &&
        (m.kind === "new_req" || m.kind === "routing" || m.kind === "link_issue" || m.kind === "deliver"),
    ),
  );

  const fallbackAreaRef = useRef<HTMLTextAreaElement | null>(null);
  if (!m) return null;

  const close = () => setModal(null);
  const bridgeConnected = Boolean(project?.bridge.connected);
  const harnesses = hub?.harnesses ?? [];
  const routing = hub?.routing ?? null;
  const detail = reqData?.detail ?? null;

  if (m.kind === "new_req") {
    const mode = m.mode ?? "create";
    const createIssueChecked =
      m.createGitHubIssue ?? Boolean(project?.project?.github?.autoCreateIssue && githubStatus?.ready);

    return (
      <ModalShell onClose={close} testId="new-req-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>新建需求</h3>
          <div className="segmented" role="tablist" aria-label="新建需求方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "create"}
              className={mode === "create" ? "active" : ""}
              data-testid="new-req-mode-create"
              onClick={() =>
                setModal((prev) => (prev?.kind === "new_req" ? { ...prev, mode: "create" } : prev))
              }
            >
              直接描述
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "import_issue"}
              className={mode === "import_issue" ? "active" : ""}
              data-testid="new-req-mode-import"
              onClick={() =>
                setModal((prev) =>
                  prev?.kind === "new_req" ? { ...prev, mode: "import_issue", issueRef: prev.issueRef ?? "" } : prev,
                )
              }
            >
              从 GitHub Issue 导入
            </button>
          </div>
        </div>

        {mode === "create" ? (
          <>
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
            <AttachmentPicker
              value={m.attachments ?? []}
              onChange={(attachments) =>
                setModal((prev) => (prev?.kind === "new_req" ? { ...prev, attachments } : prev))
              }
              disabled={busy}
            />
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                data-testid="new-req-create-issue"
                checked={createIssueChecked}
                disabled={githubStatus !== undefined && !githubStatus.ready}
                onChange={(e) =>
                  setModal((prev) =>
                    prev?.kind === "new_req" ? { ...prev, createGitHubIssue: e.target.checked } : prev,
                  )
                }
              />
              <span>
                同步在 GitHub 创建 Issue
                {githubStatus?.repo ? ` (${githubStatus.repo})` : ""}
                {githubStatus && !githubStatus.ready ? ` — ${githubStatus.reason}` : ""}
              </span>
            </label>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={close}>
                取消
              </button>
              <button
                className="btn"
                type="button"
                data-testid="save-draft-btn"
                disabled={busy}
                onClick={() =>
                  void submitNewRequirement(
                    m.goal,
                    false,
                    bridgeConnected,
                    createIssueChecked,
                    (m.attachments ?? []).map((a) => a.id),
                  )
                }
              >
                仅保存草稿
              </button>
              <button
                className="btn primary"
                type="button"
                data-testid="create-and-dispatch-btn"
                disabled={busy}
                onClick={() =>
                  void submitNewRequirement(
                    m.goal,
                    true,
                    bridgeConnected,
                    createIssueChecked,
                    (m.attachments ?? []).map((a) => a.id),
                  )
                }
              >
                创建并让 Agent 整理方案
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="muted" style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
              GitHub Issue 编号或完整 URL{githubStatus?.repo ? `（默认仓库 ${githubStatus.repo}）` : ""}
            </label>
            <input
              className="input"
              id="import-issue-ref"
              data-testid="import-issue-ref"
              autoFocus
              value={m.issueRef ?? ""}
              placeholder="例如 #42、42 或 https://github.com/owner/repo/issues/42"
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "new_req" ? { ...prev, issueRef: e.target.value } : prev))
              }
            />
            {githubStatus && !githubStatus.ready && (
              <div className="callout warning xs" style={{ marginTop: 8 }}>
                {githubStatus.reason}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" type="button" onClick={close}>
                取消
              </button>
              <button
                className="btn"
                type="button"
                data-testid="import-issue-draft-btn"
                disabled={busy}
                onClick={() => void submitImportGitHubIssue(m.issueRef ?? "", false)}
              >
                仅导入草稿
              </button>
              <button
                className="btn primary"
                type="button"
                data-testid="import-issue-dispatch-btn"
                disabled={busy}
                onClick={() => void submitImportGitHubIssue(m.issueRef ?? "", true)}
              >
                导入并让 Agent 整理方案
              </button>
            </div>
          </>
        )}
      </ModalShell>
    );
  }

  if (m.kind === "add_project") {
    const browse = m.browse;
    const nodes = hub?.nodes ?? [];
    const connectedNodes = nodes.filter((n) => n.isLocal || n.connected);
    const selectedNodeId = m.nodeId || "local";
    const originHint = typeof window !== "undefined" ? window.location.origin : "http://<ubuntu-ip>:4318";

    const browseDir = async (targetPath?: string, nodeOverride?: string) => {
      const targetNode = nodeOverride ?? selectedNodeId;
      try {
        const next = await api.browseFs(targetPath, targetNode);
        setModal((prev) =>
          prev?.kind === "add_project"
            ? { ...prev, nodeId: targetNode, browse: next, pathInput: next.currentPath }
            : prev,
        );
      } catch (err) {
        setModal((prev) =>
          prev?.kind === "add_project"
            ? { ...prev, nodeId: targetNode, browse: null, pathInput: "" }
            : prev,
        );
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
          ...(selectedNodeId !== "local" ? { nodeId: selectedNodeId } : {}),
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>添加或切换项目目录</h3>
          <button
            className="btn ghost xs"
            type="button"
            data-testid="toggle-node-help-btn"
            onClick={() =>
              setModal((prev) => (prev?.kind === "add_project" ? { ...prev, showNodeHelp: !prev.showNodeHelp } : prev))
            }
          >
            {m.showNodeHelp ? "收起 WSL2 接入指引" : "+ 如何接入 Windows WSL2？"}
          </button>
        </div>

        {(connectedNodes.length > 1 || selectedNodeId !== "local") && (
          <div style={{ marginBottom: 10 }}>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              项目所在设备节点
            </label>
            <div className="segmented" role="tablist" aria-label="选择设备节点" data-testid="add-project-node-tabs">
              {connectedNodes.map((n) => (
                <button
                  key={n.nodeId}
                  type="button"
                  role="tab"
                  aria-selected={selectedNodeId === n.nodeId}
                  className={selectedNodeId === n.nodeId ? "active" : ""}
                  data-testid={`add-project-node-${n.nodeId}`}
                  onClick={() => void browseDir(undefined, n.nodeId)}
                >
                  <Icon icon={n.isLocal ? Server : Laptop} size={14} /> {n.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {m.showNodeHelp && (
          <div className="callout info xs" style={{ marginBottom: 10 }} data-testid="node-connect-guide">
            <div>
              <strong>将 Windows WSL2 中的工作项目挂载到此 Web UI（平时零负载，按需执行）：</strong>
            </div>
            <div style={{ marginTop: 4 }}>
              在 Windows WSL2 终端运行一次以下命令，即可在上方切换选择 WSL2 目录：
            </div>
            <pre style={{ margin: "6px 0 0", fontFamily: "var(--mono)", fontSize: 11.5, whiteSpace: "pre-wrap" }}>
              {`wb node install --hub ${originHint} --token <访问密码> --id wsl-work --name "Windows WSL2"`}
            </pre>
            <div className="muted" style={{ marginTop: 4 }}>
              注：访问密码可在当前主控机执行 <code>wb service password</code> 查看或重置。
            </div>
          </div>
        )}

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
            placeholder="/home/tsien/code/your-project"
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
    const tab = m.tab ?? "global";
    const cfg = m.draft ?? routing;
    const hubLangValue = m.hubLangDraft ?? hub?.outputLanguage ?? "zh-CN";
    const savedHubLang = hub?.outputLanguage ?? "zh-CN";
    const projLangValue = m.projLangDraft ?? project?.project?.outputLanguage ?? "inherit";
    const ghRepoValue = m.ghRepoDraft ?? project?.project?.github?.repo ?? githubStatus?.repo ?? "";
    const ghBaseValue =
      m.ghBaseBranchDraft ?? project?.project?.github?.defaultBaseBranch ?? githubStatus?.defaultBaseBranch ?? "main";
    const ghAutoCreateValue = m.ghAutoCreateDraft ?? Boolean(project?.project?.github?.autoCreateIssue);
    const ghAutoSyncValue = m.ghAutoSyncDraft ?? (project?.project?.github?.autoSyncIssue ?? true);

    const syncHubStatePatch = async (
      patch: Partial<Pick<HubStateResponse, "routing" | "harnesses" | "outputLanguage">>,
    ) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.hubState });
      queryClient.setQueryData<HubStateResponse>(queryKeys.hubState, (prev) =>
        prev ? { ...prev, ...patch } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
    };

    const refreshHarnesses = async () => {
      const targetNodeId = hub?.activeNodeId;
      const res = await runBusy(() => api.refreshHarnesses(targetNodeId));
      if (res) {
        await syncHubStatePatch({ harnesses: res.harnesses });
        const nodeLabel = hub?.nodes?.find((n) => n.nodeId === targetNodeId)?.name ?? "本机";
        showToast(`已刷新 ${nodeLabel} CLI 与模型列表`);
      }
    };

    const applyPreset = async (preset: RoutingPreset) => {
      const res = await runBusy(() => api.applyPreset(preset));
      if (res) {
        await syncHubStatePatch({ routing: res.routing });
        setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: res.routing } : prev));
        showToast(`已应用策略预设：${preset}`);
      }
    };

    const saveGlobal = async () => {
      if (!cfg) return;
      const res = await runBusy(async () => {
        const routingRes = await api.saveRouting(cfg);
        const prefRes = await api.updateHubPreferences({ outputLanguage: hubLangValue });
        return { routingRes, prefRes };
      });
      if (res) {
        await syncHubStatePatch({ routing: res.routingRes.routing, outputLanguage: res.prefRes.outputLanguage });
        setModal(null);
        showToast("全局设置已保存");
      }
    };

    const saveProject = async () => {
      const out = await runBusy(() =>
        api.updateProjectSettings({
          outputLanguage: projLangValue,
          github: {
            repo: ghRepoValue.trim(),
            defaultBaseBranch: ghBaseValue.trim() || "main",
            autoCreateIssue: ghAutoCreateValue,
            autoSyncIssue: ghAutoSyncValue,
          },
        }),
      );
      if (out) {
        await invalidateAllWorkbenchQueries();
        setModal(null);
        showToast("项目设置已保存");
      }
    };

    return (
      <ModalShell onClose={close} wide testId="routing-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>工作台设置</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div className="segmented" role="tablist" aria-label="设置作用域">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "global"}
                className={tab === "global" ? "active" : ""}
                data-testid="settings-tab-global"
                onClick={() => setModal((prev) => (prev?.kind === "routing" ? { ...prev, tab: "global" } : prev))}
              >
                <Icon icon={Globe} size={14} /> 全局设置
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "project"}
                className={tab === "project" ? "active" : ""}
                data-testid="settings-tab-project"
                onClick={() => setModal((prev) => (prev?.kind === "routing" ? { ...prev, tab: "project" } : prev))}
              >
                <Icon icon={Folder} size={14} /> 项目设置
              </button>
            </div>
            {tab === "global" && (
              <button
                className="btn xs"
                type="button"
                data-testid="refresh-harnesses-btn"
                disabled={busy}
                onClick={() => void refreshHarnesses()}
              >
                <Icon icon={RefreshCw} size={14} /> 重新探测本机模型
              </button>
            )}
          </div>
        </div>

        {tab === "global" ? (
          <div data-testid="settings-pane-global">
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
                            const parsed = parseRunnerKey(e.target.value);
                            if (!parsed || !cfg) return;
                            const { harness, model } = parsed;
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
                                    {mod.source === "builtin" ? " · 未验证" : ""}
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

            <div className="callout info xs" style={{ margin: "12px 0" }}>
              所有模型调度 Prompt、交接简报（handoff.md）与 MCP 工具描述将强制遵守此处配置的计划文档输出语言，避免不同模型出现中英文混杂。
            </div>

            <div>
              <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                Hub 全局默认输出语言（对所有项目生效）
              </label>
              <select
                className="select"
                data-testid="hub-output-language-select"
                style={{ width: "100%" }}
                value={hubLangValue}
                onChange={(e) =>
                  setModal((prev) =>
                    prev?.kind === "routing" ? { ...prev, hubLangDraft: e.target.value as OutputLanguage } : prev,
                  )
                }
              >
                <option value="zh-CN">简体中文 (zh-CN) — 推荐默认</option>
                <option value="en">English (en)</option>
                <option value="auto">跟随需求输入语言 (auto)</option>
              </select>
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
                onClick={() => void saveGlobal()}
              >
                保存全局设置
              </button>
            </div>
          </div>
        ) : (
          <div data-testid="settings-pane-project">
            {noHubProject || !project?.initialized ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                请先添加并初始化一个本地项目，再配置项目级设置。
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                      当前项目（{project.project?.name}）输出语言覆盖
                    </label>
                    <select
                      className="select"
                      data-testid="project-output-language-select"
                      style={{ width: "100%" }}
                      value={projLangValue}
                      onChange={(e) =>
                        setModal((prev) =>
                          prev?.kind === "routing"
                            ? { ...prev, projLangDraft: e.target.value as OutputLanguage | "inherit" }
                            : prev,
                        )
                      }
                    >
                      <option value="inherit">继承 Hub 全局设置（当前：{savedHubLang}）</option>
                      <option value="zh-CN">简体中文 (zh-CN)</option>
                      <option value="en">English (en)</option>
                      <option value="auto">跟随需求输入语言 (auto)</option>
                    </select>
                  </div>

                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <strong style={{ fontSize: 13 }}>当前项目 GitHub 集成设置</strong>
                      {githubStatus && (
                        <span className={`badge ${githubStatus.ready ? "success" : "warning"}`}>
                          {githubStatus.ready
                            ? `gh 已就绪 (${githubStatus.account ?? "authenticated"})`
                            : githubStatus.reason ?? "未就绪"}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 8, marginBottom: 8 }}>
                      <div>
                        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                          GitHub 仓库（owner/repo，留空自动识别 origin）
                        </label>
                        <input
                          className="input"
                          data-testid="project-github-repo-input"
                          value={ghRepoValue}
                          placeholder="Jackie733/workbench"
                          onChange={(e) =>
                            setModal((prev) =>
                              prev?.kind === "routing" ? { ...prev, ghRepoDraft: e.target.value } : prev,
                            )
                          }
                        />
                      </div>
                      <div>
                        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                          PR 默认 Base 分支
                        </label>
                        <input
                          className="input"
                          data-testid="project-github-base-input"
                          value={ghBaseValue}
                          placeholder="main"
                          onChange={(e) =>
                            setModal((prev) =>
                              prev?.kind === "routing" ? { ...prev, ghBaseBranchDraft: e.target.value } : prev,
                            )
                          }
                        />
                      </div>
                    </div>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        data-testid="project-github-autocreate"
                        checked={ghAutoCreateValue}
                        onChange={(e) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, ghAutoCreateDraft: e.target.checked } : prev,
                          )
                        }
                      />
                      <span>新建需求或痛点转化需求时自动在 GitHub 创建对应 Issue</span>
                    </label>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        data-testid="project-github-autosync"
                        checked={ghAutoSyncValue}
                        onChange={(e) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, ghAutoSyncDraft: e.target.checked } : prev,
                          )
                        }
                      />
                      <span>验收通过与创建 PR 时自动向已关联 GitHub Issue 同步评论进展</span>
                    </label>
                  </div>
                </div>

                <div className="modal-actions">
                  <button className="btn" type="button" onClick={close}>
                    取消
                  </button>
                  <button
                    className="btn primary"
                    type="button"
                    data-testid="save-project-btn"
                    disabled={busy}
                    onClick={() => void saveProject()}
                  >
                    保存项目设置
                  </button>
                </div>
              </>
            )}
          </div>
        )}
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

  if (m.kind === "quick_report") {
    if (m.pickingElement) return null;

    const submitQuickReport = async () => {
      const title = m.title.trim();
      if (!title) {
        showToast("请填写问题或改进标题", true);
        return;
      }
      const attachmentIds = (m.attachments ?? []).map((a) => a.id);
      const res = await runBusy(async () => {
        const rep = await api.reportPainPoint({
          source: "ui_quick_report",
          category: m.category,
          title,
          detail: m.detail.trim() || undefined,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          context: {
            nodeId: hub?.activeNodeId && hub.activeNodeId !== "local" ? hub.activeNodeId : undefined,
            projectRoot: project?.root,
            requirementId: selectedId ?? undefined,
            domSelector: m.domSelector.trim() || undefined,
            viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : undefined,
            theme: useUiStore.getState().theme,
            urlPath: typeof window !== "undefined" ? window.location.pathname : undefined,
          },
        });
        let promoted: { id: string; projectId: string; warning?: string } | null = null;
        if (m.autoPromote && rep.painPoint) {
          const out = await api.promotePainPoint(rep.painPoint.id, {
            createSandbox: true,
            ...(m.createGitHubIssue !== undefined ? { createGitHubIssue: m.createGitHubIssue } : {}),
          });
          promoted = {
            id: out.requirement.state.id,
            projectId: out.workbenchProjectId,
            warning: out.githubIssueWarning,
          };
        }
        return { painPoint: rep.painPoint, promoted };
      });
      if (res) {
        setModal(null);
        await invalidateAllWorkbenchQueries();
        if (res.promoted) {
          setApiProjectScope(res.promoted.projectId);
          setActiveProjectId(res.promoted.projectId);
          await openRequirement(res.promoted.id);
          showToast(
            res.promoted.warning
              ? `已建单并创建沙箱需求 ${res.promoted.id}（Issue 未同步：${res.promoted.warning}）`
              : `已建单并创建沙箱需求 ${res.promoted.id}`,
          );
        } else {
          showToast("已记录到自进化痛点收集箱");
        }
      }
    };

    return (
      <ModalShell onClose={close} testId="quick-report-modal">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Icon icon={Zap} size={20} />
          <h3 style={{ margin: 0 }}>随手报修与自进化反馈</h3>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            className="select"
            aria-label="问题分类"
            data-testid="quick-report-category"
            value={m.category}
            onChange={(e) =>
              setModal((prev) =>
                prev?.kind === "quick_report"
                  ? { ...prev, category: e.target.value as PainPointCategory }
                  : prev,
              )
            }
          >
            <option value="ui_anomaly">UI 异常 / 布局交互问题</option>
            <option value="cli_ergonomics">CLI / Agent 工具摩擦</option>
            <option value="harness_bug">Harness / 模型调度异常</option>
            <option value="feature_gap">工作台新能力建议</option>
          </select>
          <input
            className="input"
            aria-label="关联区域或元素选择器"
            style={{ flex: 1, minWidth: 160 }}
            data-testid="quick-report-selector"
            value={m.domSelector}
            placeholder="关联区域/元素选择器（可选）"
            onChange={(e) =>
              setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, domSelector: e.target.value } : prev))
            }
          />
          <button
            className="btn xs"
            type="button"
            data-testid="pick-element-btn"
            title="从当前页面点选元素定位问题区域"
            onClick={() =>
              setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, pickingElement: true } : prev))
            }
          >
            <Icon icon={Crosshair} size={14} /> 点选元素
          </button>
        </div>
        <input
          className="input"
          aria-label="痛点标题"
          data-testid="quick-report-title"
          autoFocus
          style={{ marginBottom: 8 }}
          value={m.title}
          placeholder="一句话描述痛点或异常（例如：移动端侧边栏按钮遮挡标题）"
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, title: e.target.value } : prev))
          }
        />
        <textarea
          className="textarea"
          aria-label="详细描述"
          data-testid="quick-report-detail"
          value={m.detail}
          placeholder="补充复现步骤或期望表现（将自动附带当前项目、需求与视口上下文）…"
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, detail: e.target.value } : prev))
          }
        />
        <AttachmentPicker
          value={m.attachments ?? []}
          onChange={(attachments) =>
            setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, attachments } : prev))
          }
          disabled={busy}
          scope="hub"
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            data-testid="quick-report-autopromote"
            checked={m.autoPromote}
            onChange={(e) =>
              setModal((prev) =>
                prev?.kind === "quick_report" ? { ...prev, autoPromote: e.target.checked } : prev,
              )
            }
          />
          <span>立即转化为 Workbench 仓库标准需求并创建隔离 Worktree 沙箱</span>
        </label>
        {m.autoPromote && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, marginLeft: 20, fontSize: 12.5 }}>
            <input
              type="checkbox"
              data-testid="quick-report-create-issue"
              checked={m.createGitHubIssue ?? false}
              onChange={(e) =>
                setModal((prev) =>
                  prev?.kind === "quick_report" ? { ...prev, createGitHubIssue: e.target.checked } : prev,
                )
              }
            />
            <span>同步在 GitHub 创建对应 Issue</span>
          </label>
        )}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-quick-report-btn"
            disabled={busy}
            onClick={() => void submitQuickReport()}
          >
            提交反馈
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "evolution") {
    const painPoints = evolutionData?.painPoints ?? [];
    const telemetry = evolutionData?.telemetry ?? { entries: [], activeCooldowns: [] };
    const sandboxes = evolutionData?.sandboxes ?? [];
    const currentPlaybook = m.playbookDraft ?? playbookData?.markdown ?? evolutionData?.playbook.markdown ?? "";

    const openWorkbenchReq = async (reqId: string, projectIdOverride?: string | null) => {
      const targetProjId =
        projectIdOverride ??
        evolutionData?.workbenchProjectId ??
        hub?.projects.find((p) => p.root === evolutionData?.workbenchRoot)?.id ??
        null;
      if (targetProjId) {
        setApiProjectScope(targetProjId);
        setActiveProjectId(targetProjId);
      }
      setModal(null);
      await openRequirement(reqId);
    };

    const handlePromote = async (painId: string) => {
      const out = await runBusy(() => api.promotePainPoint(painId, { createSandbox: true }));
      if (out) {
        await invalidateAllWorkbenchQueries();
        showToast(`已创建自进化需求 ${out.requirement.state.id}${out.sandbox ? "（已启用沙箱隔离）" : ""}`);
        await openWorkbenchReq(out.requirement.state.id, out.workbenchProjectId);
      }
    };

    const handleDismiss = async (painId: string) => {
      const out = await runBusy(() => api.dismissPainPoint(painId));
      if (out) {
        await invalidateAllWorkbenchQueries();
        showToast("已忽略该痛点");
      }
    };

    const handleApplySandbox = async (reqId: string) => {
      const out = await runBusy(() => api.applyRsiSandbox(reqId));
      if (out) {
        await invalidateAllWorkbenchQueries();
        showToast(
          out.webReloaded
            ? `已应用 ${reqId} 改动并热重载前端`
            : `已应用 ${reqId} 改动（${out.appliedFiles.length} 个文件）`,
        );
      }
    };

    const handleSyncSandboxPr = async (reqId: string) => {
      const out = await runBusy(() => api.syncRsiSandboxPr(reqId));
      if (out) {
        await invalidateAllWorkbenchQueries();
        showToast(
          out.pr.state === "merged"
            ? `PR #${out.pr.number} 已合并${out.cleanedSandbox ? "并清理沙箱" : ""}`
            : `PR #${out.pr.number} 当前状态：${out.pr.state}`,
        );
      }
    };

    const handleSavePlaybook = async () => {
      const out = await runBusy(() => api.savePlaybook(currentPlaybook));
      if (out) {
        setModal((prev) => (prev?.kind === "evolution" ? { ...prev, playbookDraft: out.markdown } : prev));
        await invalidateAllWorkbenchQueries();
        showToast(`已保存项目经验法则（${out.rules.length} 条）`);
      }
    };

    const handleDistillPlaybook = async () => {
      const out = await runBusy(() => api.distillPlaybook());
      if (out) {
        setModal((prev) => (prev?.kind === "evolution" ? { ...prev, playbookDraft: out.markdown } : prev));
        await invalidateAllWorkbenchQueries();
        showToast(out.added > 0 ? `已从历史需求提炼 ${out.added} 条新经验` : "暂无新的可提炼经验");
      }
    };

    return (
      <ModalShell onClose={close} wide testId="evolution-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon icon={Sparkles} size={20} />
            <h3 style={{ margin: 0 }}>自进化与 RSI 中心</h3>
          </div>
          <div className="segmented" role="tablist" aria-label="自进化功能视图">
            <button
              type="button"
              role="tab"
              aria-selected={m.tab === "inbox"}
              className={m.tab === "inbox" ? "active" : ""}
              data-testid="evo-tab-inbox"
              onClick={() => setModal({ ...m, tab: "inbox" })}
            >
              痛点收集箱 ({painPoints.filter((p) => p.status === "open").length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={m.tab === "playbook"}
              className={m.tab === "playbook" ? "active" : ""}
              data-testid="evo-tab-playbook"
              onClick={() => setModal({ ...m, tab: "playbook", playbookDraft: null })}
            >
              项目经验库 ({playbookData?.rules.length ?? evolutionData?.playbook.rules.length ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={m.tab === "telemetry"}
              className={m.tab === "telemetry" ? "active" : ""}
              data-testid="evo-tab-telemetry"
              onClick={() => setModal({ ...m, tab: "telemetry" })}
            >
              模型遥测 ({telemetry.entries.length})
            </button>
          </div>
        </div>

        {m.tab === "inbox" && (
          <div role="tabpanel" data-testid="evo-pane-inbox">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
              <span className="xs muted">
                自动嗅探运行死胡同、CLI 参数摩擦与前端异常；也可通过右上角「报修」或 CLI <code>wb issue</code> 上报。
              </span>
              <button
                className="btn xs"
                type="button"
                onClick={() =>
                  setModal({
                    kind: "quick_report",
                    title: "",
                    detail: "",
                    category: "ui_anomaly",
                    domSelector: "",
                    pickingElement: false,
                    autoPromote: false,
                  })
                }
              >
                <Icon icon={Zap} size={14} /> 新增痛点
              </button>
            </div>
            {painPoints.length === 0 ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                暂无记录的工作台痛点。
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
                {painPoints.map((p) => {
                  const sandboxItem = p.promotedReqId ? sandboxes.find((s) => s.requirementId === p.promotedReqId) : undefined;
                  return (
                    <div key={p.id} className="callout" data-testid={`pain-item-${p.id}`}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                            <span className={`badge ${p.status === "open" ? "warning" : p.status === "promoted" ? "info" : "neutral"}`}>
                              {p.status === "open" ? "待处理" : p.status === "promoted" ? `已转 ${p.promotedReqId}` : "已忽略"}
                            </span>
                            <span className="badge">{p.category}</span>
                            {p.occurrences > 1 && <span className="badge info">发生 {p.occurrences} 次</span>}
                            {sandboxItem?.stage && sandboxItem.stage !== "done" && (
                              <span className="badge">沙箱 {sandboxItem.stage}</span>
                            )}
                            {sandboxItem?.github?.issue && (
                              <span className="badge info">Issue #{sandboxItem.github.issue.number}</span>
                            )}
                            {sandboxItem?.github?.pr && (
                              <span className={`badge ${sandboxItem.github.pr.state === "merged" ? "success" : "info"}`}>
                                PR #{sandboxItem.github.pr.number} · {sandboxItem.github.pr.state}
                              </span>
                            )}
                            <span className="xs muted">{formatDateTime(p.updatedAt)}</span>
                          </div>
                          <div style={{ fontWeight: 600 }}>{p.title}</div>
                          {p.detail && p.detail !== p.title && (
                            <div className="xs muted" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
                              {p.detail.slice(0, 260)}
                            </div>
                          )}
                          {p.attachments && p.attachments.length > 0 && (
                            <div style={{ marginTop: 6 }}>
                              <AttachmentGallery
                                attachments={p.attachments}
                                urlFor={(attId) => evolutionAttachmentUrl(p.id, attId)}
                              />
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                          {p.status === "open" && (
                            <>
                              <button
                                className="btn primary xs"
                                type="button"
                                data-testid={`promote-pain-${p.id}`}
                                disabled={busy}
                                onClick={() => void handlePromote(p.id)}
                              >
                                <Icon icon={Flame} size={14} /> 转为需求并建沙箱
                              </button>
                              <button
                                className="btn ghost xs"
                                type="button"
                                data-testid={`dismiss-pain-${p.id}`}
                                disabled={busy}
                                onClick={() => void handleDismiss(p.id)}
                              >
                                <Icon icon={Trash2} size={14} /> 忽略
                              </button>
                            </>
                          )}
                          {p.status === "promoted" && p.promotedReqId && (
                            <button
                              className="btn xs"
                              type="button"
                              data-testid={`open-promoted-${p.id}`}
                              disabled={busy}
                              onClick={() => void openWorkbenchReq(p.promotedReqId!)}
                            >
                              <Icon icon={ExternalLink} size={14} /> 查看需求
                            </button>
                          )}
                          {sandboxItem?.canApply && p.promotedReqId && sandboxItem.github?.pr && (
                            <button
                              className="btn primary xs"
                              type="button"
                              data-testid={`sync-pain-pr-${p.id}`}
                              disabled={busy}
                              onClick={() => void handleSyncSandboxPr(p.promotedReqId!)}
                            >
                              <Icon icon={RefreshCw} size={14} /> 同步 PR 并清理沙箱
                            </button>
                          )}
                          {sandboxItem?.canApply && p.promotedReqId && (
                            <button
                              className={sandboxItem.github?.pr ? "btn xs" : "btn primary xs"}
                              type="button"
                              data-testid={`apply-pain-sandbox-${p.id}`}
                              disabled={busy}
                              onClick={() => void handleApplySandbox(p.promotedReqId!)}
                            >
                              <Icon icon={Check} size={14} /> 应用沙箱改动
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {m.tab === "playbook" && (
          <div role="tabpanel" data-testid="evo-pane-playbook">
            {noHubProject ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                请先添加并选择一个本地项目，再管理项目经验库。
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
                  <span className="xs muted">
                    保存于当前项目 <code>.workbench/playbook.md</code>，每次执行 Agent 时自动注入交接简报。
                  </span>
                  <button
                    className="btn xs"
                    type="button"
                    data-testid="distill-playbook-btn"
                    disabled={busy}
                    onClick={() => void handleDistillPlaybook()}
                  >
                    <Icon icon={RefreshCw} size={14} /> 从历史需求提炼
                  </button>
                </div>
                <textarea
                  className="textarea"
                  aria-label="项目经验法则 Playbook Markdown"
                  data-testid="playbook-editor"
                  style={{ minHeight: 240, fontFamily: "var(--mono)", fontSize: 12.5 }}
                  value={currentPlaybook}
                  placeholder="- [避坑] 在此记录项目级工程规范与踩坑经验…"
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "evolution" ? { ...prev, playbookDraft: e.target.value } : prev))
                  }
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                  <button
                    className="btn primary xs"
                    type="button"
                    data-testid="save-playbook-btn"
                    disabled={busy}
                    onClick={() => void handleSavePlaybook()}
                  >
                    保存经验法则
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {m.tab === "telemetry" && (
          <div role="tabpanel" data-testid="evo-pane-telemetry">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
              <span className="xs muted">
                自动追踪各模型在不同阶段的胜率与平均耗时；触发真实限流将进入 15 分钟自动冷却并跳过。
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {telemetry.activeCooldowns.length > 0 && (
                  <button
                    className="btn xs"
                    type="button"
                    data-testid="clear-cooldown-btn"
                    disabled={busy}
                    onClick={async () => {
                      const out = await runBusy(() => api.clearModelCooldown());
                      if (out) {
                        await invalidateAllWorkbenchQueries();
                        showToast("已清除所有模型限流冷却");
                      }
                    }}
                  >
                    清除冷却 ({telemetry.activeCooldowns.length})
                  </button>
                )}
                <button
                  className="btn xs"
                  type="button"
                  data-testid="reload-web-btn"
                  disabled={busy}
                  onClick={async () => {
                    const out = await runBusy(() => api.reloadWebBundle());
                    if (out?.reloaded) showToast("前端 Bundle 已重新编译并推送热刷新");
                  }}
                >
                  <Icon icon={RefreshCw} size={14} /> 热重建前端
                </button>
              </div>
            </div>
            {telemetry.entries.length === 0 ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                暂无模型执行遥测记录。
              </div>
            ) : (
              <div style={{ maxHeight: "48vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {telemetry.entries.map((e) => {
                  const rate = e.totalRuns > 0 ? Math.round((e.succeededRuns / e.totalRuns) * 100) : 0;
                  const cooling = telemetry.activeCooldowns.some((c) => c.harness === e.harness && c.model === e.model);
                  return (
                    <div
                      key={`${e.harness}::${e.model}::${e.action}`}
                      className="routing-row"
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {e.harness} · {e.model} <span className="badge">{e.action}</span>{" "}
                          {cooling && <span className="badge warning">冷却中</span>}
                        </div>
                        <div className="xs muted">
                          总执行 {e.totalRuns} 次 · 平均耗时 {(e.avgDurationMs / 1000).toFixed(1)}s
                          {e.timedOutRuns > 0 ? ` · 超时 ${e.timedOutRuns}` : ""}
                          {e.rateLimitedRuns > 0 ? ` · 限流 ${e.rateLimitedRuns}` : ""}
                          {e.degradedRuns > 0 ? ` · 降级 ${e.degradedRuns}` : ""}
                        </div>
                      </div>
                      <span className={`badge ${rate >= 70 ? "success" : rate >= 40 ? "warning" : "danger"}`}>
                        成功率 {rate}%
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" type="button" data-action="close-modal" onClick={close}>
            关闭
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "link_issue") {
    const submitLinkIssue = async () => {
      if (m.mode === "link" && !m.issueRef.trim()) {
        showToast("请输入 GitHub Issue 编号或 URL", true);
        return;
      }
      const res = await runBusy(() =>
        api.linkRequirementIssue(
          m.requirementId,
          m.mode === "link" ? { issueRef: m.issueRef.trim() } : {},
        ),
      );
      if (res) {
        setModal(null);
        await invalidateAllWorkbenchQueries();
        const num = res.detail.state.github?.issue?.number;
        showToast(num ? `已关联 GitHub Issue #${num}` : "已关联 GitHub Issue");
      }
    };

    return (
      <ModalShell onClose={close} testId="link-issue-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>关联 GitHub Issue</h3>
          <div className="segmented" role="tablist">
            <button
              type="button"
              className={m.mode === "create" ? "active" : ""}
              onClick={() => setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, mode: "create" } : prev))}
            >
              新建并关联 Issue
            </button>
            <button
              type="button"
              className={m.mode === "link" ? "active" : ""}
              onClick={() => setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, mode: "link" } : prev))}
            >
              绑定已有 Issue
            </button>
          </div>
        </div>
        {m.mode === "create" ? (
          <div className="callout info xs">
            将根据当前需求 <strong>{m.requirementId}</strong> 的标题、目标正文与验收条件在 GitHub 仓库
            {githubStatus?.repo ? ` (${githubStatus.repo}) ` : " "}创建新 Issue 并双向绑定。
          </div>
        ) : (
          <>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              GitHub Issue 编号或完整 URL
            </label>
            <input
              className="input"
              data-testid="link-issue-ref-input"
              autoFocus
              value={m.issueRef}
              placeholder="例如 #42 或 https://github.com/owner/repo/issues/42"
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, issueRef: e.target.value } : prev))
              }
            />
          </>
        )}
        {githubStatus && !githubStatus.ready && (
          <div className="callout warning xs" style={{ marginTop: 8 }}>
            {githubStatus.reason}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-link-issue-btn"
            disabled={busy || (githubStatus !== undefined && !githubStatus.ready)}
            onClick={() => void submitLinkIssue()}
          >
            <Icon icon={Link2} size={14} /> {m.mode === "create" ? "创建并绑定" : "绑定 Issue"}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "deliver") {
    if (!detail) return null;
    const candidates = deliveryPreview?.candidates ?? [];
    const selectedSet = new Set(m.selectedFiles);
    const sandboxActive = Boolean(deliveryPreview?.sandboxActive);
    const createPr = sandboxActive ? true : Boolean(m.createPr);
    const canSubmitExistingCommits = createPr && candidates.length === 0 && (deliveryPreview?.aheadCommitsCount ?? 0) > 0;
    const prAvailable = Boolean(deliveryPreview?.canCreatePr || githubStatus?.ready);

    const toggleFile = (filePath: string) => {
      setModal((prev) => {
        if (prev?.kind !== "deliver") return prev;
        const next = new Set(prev.selectedFiles);
        if (next.has(filePath)) next.delete(filePath);
        else next.add(filePath);
        return { ...prev, selectedFiles: [...next] };
      });
    };
    const selectPreset = (mode: "accepted" | "all" | "none") => {
      const files =
        mode === "none"
          ? []
          : mode === "accepted"
            ? candidates.filter((c) => c.inAcceptedSnapshot).map((c) => c.path)
            : candidates.map((c) => c.path);
      setModal((prev) => (prev?.kind === "deliver" ? { ...prev, selectedFiles: files } : prev));
    };
    const submitDeliver = async () => {
      const files = m.selectedFiles.filter((f) => candidates.some((c) => c.path === f));
      if (files.length === 0 && !canSubmitExistingCommits) {
        showToast("请至少选择 1 个要纳入提交的文件", true);
        return;
      }
      const msg = m.commitMessage.trim();
      if (files.length > 0 && !msg) {
        showToast("请填写 Git 提交说明", true);
        return;
      }
      const res = await runBusy(() =>
        api.deliver(detail.state.id, {
          files,
          commitMessage: msg,
          expectedRevision: detail.state.revision,
          note: m.note.trim() || undefined,
          ...(createPr
            ? {
                createPr: true,
                branchName: m.branchName?.trim() || undefined,
                baseBranch: m.baseBranch?.trim() || undefined,
                prTitle: m.prTitle?.trim() || undefined,
              }
            : {}),
        }),
      );
      if (res) {
        setModal(null);
        await invalidateAllWorkbenchQueries();
        if (res.pr) {
          showToast(
            res.githubSyncWarning
              ? `已创建 PR #${res.pr.number}（Issue 同步警告：${res.githubSyncWarning}）`
              : `已推送分支并创建 PR #${res.pr.number}`,
          );
        } else {
          showToast(
            res.restartRecommended
              ? `已提交交付 ${res.delivery.shortHash}（${res.delivery.files.length} 个文件）；检测到服务端变更，建议执行 wb restart 重启生效`
              : res.webReloaded
                ? `已提交交付 ${res.delivery.shortHash}（${res.delivery.files.length} 个文件）并热刷新前端`
                : `已提交交付 ${res.delivery.shortHash}（${res.delivery.files.length} 个文件）`,
          );
        }
      }
    };

    return (
      <ModalShell onClose={close} testId="deliver-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>{createPr ? "标准化交付 · 提交并创建 GitHub PR" : "交付收尾 · 提交代码到 Git"}</h3>
          {!sandboxActive && (
            <div className="segmented" role="tablist" aria-label="交付方式">
              <button
                type="button"
                className={!createPr ? "active" : ""}
                data-testid="deliver-mode-local"
                onClick={() => setModal((prev) => (prev?.kind === "deliver" ? { ...prev, createPr: false } : prev))}
              >
                仅本地提交
              </button>
              <button
                type="button"
                className={createPr ? "active" : ""}
                data-testid="deliver-mode-pr"
                disabled={!prAvailable}
                onClick={() => setModal((prev) => (prev?.kind === "deliver" ? { ...prev, createPr: true } : prev))}
              >
                <Icon icon={GitPullRequest} size={14} /> 推送并提 PR
              </button>
            </div>
          )}
        </div>
        <div className="muted xs" style={{ marginBottom: 10 }}>
          目标需求：<strong>{detail.state.id}</strong> · 当前分支：
          <code>{deliveryPreview?.branch ?? "HEAD"}</code>
          {deliveryPreview?.githubRepo ? ` · 仓库 ${deliveryPreview.githubRepo}` : ""}
          {!createPr && " · 仅提交你勾选的文件，不会自动推送远程或覆盖其他暂存改动。"}
        </div>

        {(candidates.length > 0 || !canSubmitExistingCommits) && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>
                选择纳入本次提交的文件（已选 {m.selectedFiles.length}/{candidates.length}）
              </strong>
              <div style={{ display: "flex", gap: 6 }}>
                {candidates.some((c) => c.inAcceptedSnapshot) && (
                  <button className="btn xs" type="button" onClick={() => selectPreset("accepted")}>
                    仅选本次验收文件
                  </button>
                )}
                <button className="btn xs" type="button" onClick={() => selectPreset("all")}>
                  全选
                </button>
                <button className="btn xs" type="button" onClick={() => selectPreset("none")}>
                  清空
                </button>
              </div>
            </div>
            <div
              style={{
                maxHeight: 190,
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 8,
                marginBottom: 10,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {candidates.length === 0 ? (
                <div className="muted xs">当前工作区无未提交文件。</div>
              ) : (
                candidates.map((c) => (
                  <label
                    key={c.path}
                    style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      data-testid={`deliver-file-${c.path}`}
                      checked={selectedSet.has(c.path)}
                      onChange={() => toggleFile(c.path)}
                    />
                    <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.path}
                    </code>
                    <span className="badge neutral">{c.status}</span>
                    {deliveryPreview && deliveryPreview.acceptedSnapshotFileCount > 0 && (
                      <span className={`badge ${c.inAcceptedSnapshot ? "success" : "warning"}`}>
                        {c.inAcceptedSnapshot ? "本次验收" : "工作区其他"}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </>
        )}

        {canSubmitExistingCommits && (
          <div className="callout info xs" style={{ marginBottom: 10 }}>
            当前分支已有 <strong>{deliveryPreview?.aheadCommitsCount}</strong> 个先行提交且工作区干净，将直接推送现有提交至远端并创建 PR。
          </div>
        )}

        {(candidates.length > 0 || !canSubmitExistingCommits) && (
          <>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              Git 提交说明（Commit Message）
            </label>
            <input
              className="input"
              data-testid="deliver-commit-message"
              style={{ marginBottom: 8 }}
              value={m.commitMessage}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "deliver" ? { ...prev, commitMessage: e.target.value } : prev))
              }
            />
          </>
        )}

        {createPr && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                  推送源分支
                </label>
                <input
                  className="input"
                  data-testid="deliver-pr-branch"
                  readOnly={sandboxActive}
                  value={m.branchName ?? deliveryPreview?.suggestedBranch ?? ""}
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "deliver" ? { ...prev, branchName: e.target.value } : prev))
                  }
                />
              </div>
              <div>
                <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                  目标 Base 分支
                </label>
                <input
                  className="input"
                  data-testid="deliver-pr-base"
                  value={m.baseBranch ?? deliveryPreview?.baseBranch ?? "main"}
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "deliver" ? { ...prev, baseBranch: e.target.value } : prev))
                  }
                />
              </div>
            </div>
            <div>
              <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                GitHub PR 标题
              </label>
              <input
                className="input"
                data-testid="deliver-pr-title"
                value={m.prTitle ?? `${detail.state.id}: ${detail.state.title}`}
                onChange={(e) =>
                  setModal((prev) => (prev?.kind === "deliver" ? { ...prev, prTitle: e.target.value } : prev))
                }
              />
            </div>
            {detail.state.github?.issue && (
              <div className="xs muted">
                PR 正文将自动附带验证证据、审查结论及 <code>Closes #{detail.state.github.issue.number}</code>。
              </div>
            )}
          </div>
        )}

        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
          交付备注（可选，记录到需求时间线）
        </label>
        <input
          className="input"
          data-testid="deliver-note"
          value={m.note}
          placeholder="例如：合并至 main，准备开启下一条需求…"
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "deliver" ? { ...prev, note: e.target.value } : prev))
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            取消
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-deliver-btn"
            disabled={busy || (!canSubmitExistingCommits && m.selectedFiles.length === 0)}
            onClick={() => void submitDeliver()}
          >
            {createPr ? "提交并创建 GitHub PR" : "确认提交 Git"}
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
