import { AlertTriangle, Check, Folder, Globe, Info, Plus, RefreshCw, Save, Settings, Trash2, X } from "lucide-react";
import { DEFAULT_PROJECT_ROUTING, type GitRemoteProvider, type OutputLanguage } from "../../core/types.ts";
import {
  ROUTING_ROLES,
  type HarnessId,
  type ModelTarget,
  type ReasoningEffort,
  type RoutingConfig,
  type RoutingRole,
} from "../../hub/types.ts";
import { api, type HubStateResponse, type ProjectInfoResponse } from "../api.ts";
import {
  formatGiteeStatusReason,
  formatGitHubStatusReason,
  t,
  type MessageKey,
} from "../i18n.ts";
import {
  invalidateAllWorkbenchQueries,
  queryClient,
  queryKeys,
  resolveEffectiveRouting,
  runBusy,
  useGiteeStatusQuery,
  useGitHubStatusQuery,
  useHubStateQuery,
  useProjectQuery,
} from "../queries.ts";
import {
  effortLabel,
  getModelEffortCapability,
  parseRunnerKey,
  type ModalState,
} from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";
import { ModalShell } from "./Primitives.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { RoutingModelPicker } from "./ui/RoutingModelPicker.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";
import { SimpleSelect } from "./ui/select.tsx";

type RoutingModalData = Extract<ModalState, { kind: "routing" }>;

const ROLE_META: Record<RoutingRole, { labelKey: MessageKey; descKey: MessageKey }> = {
  defaultLead: {
    labelKey: "routing.role.defaultLead",
    descKey: "routing.role.defaultLeadDesc",
  },
  sotaLead: {
    labelKey: "routing.role.sotaLead",
    descKey: "routing.role.sotaLeadDesc",
  },
  reviewer: {
    labelKey: "routing.role.reviewer",
    descKey: "routing.role.reviewerDesc",
  },
};

export function RoutingSettingsModal({
  modal: m,
  onClose,
}: {
  modal: RoutingModalData;
  onClose: () => void;
}) {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setModal = useUiStore((s) => s.setModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const showToastKey = useUiStore((s) => s.showToastKey);

  const { data: hub } = useHubStateQuery();
  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const { data: project } = useProjectQuery(activeProjectId);
  const { data: githubStatus } = useGitHubStatusQuery(
    activeProjectId,
    Boolean(!noHubProject && project?.initialized),
  );
  const { data: giteeStatus } = useGiteeStatusQuery(
    activeProjectId,
    Boolean(!noHubProject && project?.initialized),
  );

  const isGiteeProject = project?.remoteProvider === "gitee" || Boolean(project?.project?.gitee);
  const harnesses = hub?.harnesses ?? [];
  const routing = resolveEffectiveRouting(project);
  const tab = m.tab ?? "routing";
  const cfg = m.draft ?? routing;

  const hubLangValue = m.hubLangDraft ?? hub?.outputLanguage ?? "zh-CN";
  const savedHubLang = hub?.outputLanguage ?? "zh-CN";
  const giteeTokenValue = m.giteeTokenDraft ?? "";
  const projLangValue = m.projLangDraft ?? project?.project?.outputLanguage ?? "inherit";
  const projProviderValue: GitRemoteProvider = m.projProviderDraft ?? (isGiteeProject ? "gitee" : "github");
  const ghRepoValue = m.ghRepoDraft ?? project?.project?.github?.repo ?? githubStatus?.repo ?? "";
  const ghBaseValue =
    m.ghBaseBranchDraft ?? project?.project?.github?.defaultBaseBranch ?? githubStatus?.defaultBaseBranch ?? "main";
  const ghAutoCreateValue = m.ghAutoCreateDraft ?? Boolean(project?.project?.github?.autoCreateIssue);
  const ghAutoSyncValue = m.ghAutoSyncDraft ?? (project?.project?.github?.autoSyncIssue ?? true);
  const giteeRepoValue = m.giteeRepoDraft ?? project?.project?.gitee?.repo ?? giteeStatus?.repo ?? "";
  const giteeEnterpriseValue =
    m.giteeEnterpriseDraft ?? project?.project?.gitee?.enterprise ?? giteeStatus?.enterprise ?? "";
  const giteeBaseValue =
    m.giteeBaseBranchDraft ?? project?.project?.gitee?.defaultBaseBranch ?? giteeStatus?.defaultBaseBranch ?? "master";
  const fastCmdValue = m.fastCmdDraft ?? project?.project?.verification?.fastCommand ?? "";
  const fullCmdValue = m.fullCmdDraft ?? project?.project?.verification?.fullCommand ?? "";
  const existingAutoScreenshots = project?.project?.verification?.autoScreenshots;
  const autoScreenshotsValue = m.autoScreenshotsDraft ?? existingAutoScreenshots === true;
  const existingWorktreeEnabled = project?.project?.worktree?.enabled;
  const worktreeEnabledValue = m.worktreeEnabledDraft ?? existingWorktreeEnabled !== false;
  const worktreeSetupScriptValue = m.worktreeSetupScriptDraft ?? project?.project?.worktree?.setupScript ?? "";
  const worktreeCopyFilesValue =
    m.worktreeCopyFilesDraft ?? (project?.project?.worktree?.copyFiles ?? []).join(", ");

  const syncHubStatePatch = async (
    patch: Partial<
      Pick<HubStateResponse, "harnesses" | "outputLanguage" | "giteeTokenConfigured" | "giteeTokenMasked">
    >,
  ) => {
    await queryClient.cancelQueries({ queryKey: queryKeys.hubState });
    queryClient.setQueryData<HubStateResponse>(queryKeys.hubState, (prev) =>
      prev ? { ...prev, ...patch } : prev,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
    void queryClient.invalidateQueries({ queryKey: ["project"] });
  };

  const syncProjectRoutingCache = async (nextRouting: RoutingConfig) => {
    const projKey = queryKeys.project(activeProjectId ?? hub?.activeProjectId ?? null);
    await queryClient.cancelQueries({ queryKey: projKey });
    queryClient.setQueryData<ProjectInfoResponse>(projKey, (prev) =>
      prev
        ? {
            ...prev,
            routing: nextRouting,
            project: prev.project ? { ...prev.project, routing: nextRouting } : prev.project,
          }
        : prev,
    );
    void queryClient.invalidateQueries({ queryKey: ["project"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
  };

  const updateDraft = (updater: (base: RoutingConfig) => RoutingConfig) => {
    setModal((prev) => {
      if (prev?.kind !== "routing") return prev;
      const base = prev.draft ?? routing;
      if (!base) return prev;
      return { ...prev, draft: updater(base) };
    });
  };

  const refreshHarnesses = async () => {
    const targetNodeId = hub?.activeNodeId;
    const res = await runBusy(() => api.refreshHarnesses(targetNodeId));
    if (res) {
      await syncHubStatePatch({ harnesses: res.harnesses });
      const nodeLabel =
        hub?.nodes?.find((n) => n.nodeId === targetNodeId)?.name ??
        t(useUiStore.getState().language, "common.localNode");
      showToastKey("routing.refreshedModels", { node: nodeLabel });
    }
  };

  const saveRouting = async () => {
    const modalInstanceId = useUiStore.getState().modalInstanceId;
    const snapModal = useUiStore.getState().modal;
    const lm = snapModal?.kind === "routing" ? snapModal : m;
    const latestCfg = lm.draft ?? routing;
    if (!latestCfg) return;
    const res = await runBusy(() => api.saveRouting(latestCfg));
    if (res) {
      useDraftStore.getState().clearRunnerOverrides();
      await syncProjectRoutingCache(res.routing);
      closeModal(modalInstanceId);
      showToastKey("routing.savedProject");
      void invalidateAllWorkbenchQueries();
    }
  };

  const saveSettings = async () => {
    const modalInstanceId = useUiStore.getState().modalInstanceId;
    const snapModal = useUiStore.getState().modal;
    const lm = snapModal?.kind === "routing" ? snapModal : m;
    const tokenPatch = lm.clearGiteeToken
      ? null
      : (lm.giteeTokenDraft ?? "").trim()
        ? (lm.giteeTokenDraft ?? "").trim()
        : undefined;

    const ok = await runBusy(async () => {
      if (lm.hubLangDraft !== undefined || tokenPatch !== undefined) {
        const prefRes = await api.updateHubPreferences({
          ...(lm.hubLangDraft !== undefined ? { outputLanguage: lm.hubLangDraft } : {}),
          ...(tokenPatch !== undefined ? { giteeAccessToken: tokenPatch } : {}),
        });
        await syncHubStatePatch({
          outputLanguage: prefRes.outputLanguage,
          ...(prefRes.giteeTokenConfigured !== undefined
            ? { giteeTokenConfigured: prefRes.giteeTokenConfigured }
            : {}),
          ...(prefRes.giteeTokenMasked !== undefined ? { giteeTokenMasked: prefRes.giteeTokenMasked } : {}),
        });
      }

      if (!noHubProject && project?.initialized) {
        const latestProjLang = lm.projLangDraft ?? project.project?.outputLanguage ?? "inherit";
        const latestProjProvider: GitRemoteProvider = lm.projProviderDraft ?? (isGiteeProject ? "gitee" : "github");
        const latestGhRepo = lm.ghRepoDraft ?? project.project?.github?.repo ?? githubStatus?.repo ?? "";
        const latestGhBase =
          lm.ghBaseBranchDraft ?? project.project?.github?.defaultBaseBranch ?? githubStatus?.defaultBaseBranch ?? "main";
        const latestGhAutoCreate = lm.ghAutoCreateDraft ?? Boolean(project.project?.github?.autoCreateIssue);
        const latestGhAutoSync = lm.ghAutoSyncDraft ?? (project.project?.github?.autoSyncIssue ?? true);
        const latestGiteeRepo = lm.giteeRepoDraft ?? project.project?.gitee?.repo ?? giteeStatus?.repo ?? "";
        const latestGiteeEnterprise =
          lm.giteeEnterpriseDraft ?? project.project?.gitee?.enterprise ?? giteeStatus?.enterprise ?? "";
        const latestGiteeBase =
          lm.giteeBaseBranchDraft ?? project.project?.gitee?.defaultBaseBranch ?? giteeStatus?.defaultBaseBranch ?? "master";
        const latestFastCmd = lm.fastCmdDraft ?? project.project?.verification?.fastCommand ?? "";
        const latestFullCmd = lm.fullCmdDraft ?? project.project?.verification?.fullCommand ?? "";
        const latestWtEnabled = lm.worktreeEnabledDraft ?? existingWorktreeEnabled !== false;
        const latestWtScript = (lm.worktreeSetupScriptDraft ?? project.project?.worktree?.setupScript ?? "").trim();
        const latestWtFilesRaw =
          lm.worktreeCopyFilesDraft ?? (project.project?.worktree?.copyFiles ?? []).join(", ");
        const latestWtFiles = latestWtFilesRaw
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);

        await api.updateProjectSettings({
          outputLanguage: latestProjLang,
          verification: {
            fastCommand: latestFastCmd.trim(),
            fullCommand: latestFullCmd.trim(),
            ...(lm.autoScreenshotsDraft !== undefined
              ? { autoScreenshots: lm.autoScreenshotsDraft }
              : existingAutoScreenshots !== undefined
                ? { autoScreenshots: existingAutoScreenshots }
                : {}),
          },
          worktree: {
            enabled: latestWtEnabled,
            setupScript: latestWtScript,
            copyFiles: latestWtFiles,
          },
          ...(latestProjProvider === "gitee"
            ? {
                gitee: {
                  repo: latestGiteeRepo.trim(),
                  enterprise: latestGiteeEnterprise.trim(),
                  defaultBaseBranch: latestGiteeBase.trim() || "master",
                },
                github: null,
              }
            : {
                github: {
                  repo: latestGhRepo.trim(),
                  defaultBaseBranch: latestGhBase.trim() || "main",
                  autoCreateIssue: latestGhAutoCreate,
                  autoSyncIssue: latestGhAutoSync,
                },
                gitee: null,
              }),
        });
      }
      return true;
    });

    if (ok) {
      closeModal(modalInstanceId);
      showToastKey("routing.savedProject");
      void invalidateAllWorkbenchQueries();
    }
  };

  const firstInstalledTarget = (): ModelTarget => {
    for (const h of harnesses) {
      if (h.installed && h.models.length > 0) {
        return { harness: h.id, model: h.models[0]!.id };
      }
    }
    return { ...DEFAULT_PROJECT_ROUTING.defaultLead.primary };
  };

  return (
    <ModalShell
      onClose={onClose}
      wide
      testId="routing-modal"
      hasExplicitTitle
      className="[&_[data-slot=dialog-header]]:px-5 [&_[data-slot=dialog-header]]:py-2 [&_[data-slot=dialog-panel]]:px-5 [&_[data-slot=dialog-panel]]:py-2 [&_[data-slot=dialog-footer]]:px-5 [&_[data-slot=dialog-footer]]:py-2"
    >
      <DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2 pe-6">
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={Settings} size={20} />
            <span>{t(language, "routing.title")}</span>
          </DialogTitle>
          <div className="flex items-center gap-2">
            <SegmentedControl
              size="sm"
              aria-label={t(language, "routing.scopeAria")}
              render={
                <RadioGroupPrimitive
                  className="flex items-center"
                  value={tab}
                  onValueChange={(next) => {
                    if (next === "routing" || next === "project") {
                      setModal((prev) => (prev?.kind === "routing" ? { ...prev, tab: next } : prev));
                    }
                  }}
                />
              }
            >
              <SegmentedControlItem
                render={<RadioPrimitive.Root value="routing" data-testid="settings-tab-routing" />}
              >
                <Icon icon={Settings} size={14} /> {t(language, "routing.tab.routing")}
              </SegmentedControlItem>
              <SegmentedControlItem
                render={<RadioPrimitive.Root value="project" data-testid="settings-tab-project" />}
              >
                <Icon icon={Folder} size={14} /> {t(language, "routing.project")}
              </SegmentedControlItem>
            </SegmentedControl>
            {tab === "routing" && (
              <AsyncButton
                variant="outline"
                size="xs"
                type="button"
                data-testid="refresh-harnesses-btn"
                disabled={busy}
                onAction={refreshHarnesses}
              >
                <Icon icon={RefreshCw} size={14} /> {t(language, "routing.refreshHarnesses")}
              </AsyncButton>
            )}
          </div>
        </div>
      </DialogHeader>

      {tab === "routing" ? (
        <div data-testid="settings-pane-routing" className="contents">
          {noHubProject || !project?.initialized || !cfg ? (
            <>
              <DialogPanel>
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  {t(language, "routing.uninitializedHint")}
                </div>
              </DialogPanel>
              <DialogFooter>
                <Button variant="ghost" type="button" onClick={onClose}>
                  <Icon icon={X} size={14} /> {t(language, "common.close")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogPanel className="space-y-3">
                <div className="space-y-2.5" data-testid="routing-roles-list">
                  {ROUTING_ROLES.map((role) => {
                    const rule = cfg[role];
                    const selectedVal = `${rule.primary.harness}::${rule.primary.model}`;
                    const effortCap = getModelEffortCapability(harnesses, rule.primary.harness, rule.primary.model);
                    const efforts = effortCap.efforts;
                    const lockedEffort = effortCap.defaultEffort ?? efforts[0];
                    const lockedLabel = t(language, "routing.effortLockedLabel", {
                      effort: lockedEffort ? effortLabel(language, lockedEffort) : t(language, "routing.effortBuiltin"),
                    });

                    return (
                      <div key={role} className="rounded-lg border p-3 space-y-2" data-testid={`routing-role-${role}`}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-semibold">{t(language, ROLE_META[role].labelKey)}</div>
                            <div className="xs muted">{t(language, ROLE_META[role].descKey)}</div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <RoutingModelPicker
                              testId={`route-select-${role}`}
                              harnesses={harnesses}
                              value={selectedVal}
                              ariaLabel={t(language, ROLE_META[role].labelKey)}
                              onChange={(key) => {
                                const parsed = parseRunnerKey(key);
                                if (!parsed) return;
                                const nextCap = getModelEffortCapability(harnesses, parsed.harness, parsed.model);
                                updateDraft((base) => {
                                  const prevRule = base[role];
                                  const keepEffort =
                                    nextCap.mode === "configurable" &&
                                    prevRule.primary.reasoningEffort &&
                                    nextCap.efforts.includes(prevRule.primary.reasoningEffort)
                                      ? prevRule.primary.reasoningEffort
                                      : undefined;
                                  return {
                                    ...base,
                                    [role]: {
                                      ...prevRule,
                                      primary: {
                                        harness: parsed.harness as HarnessId,
                                        model: parsed.model,
                                        ...(keepEffort ? { reasoningEffort: keepEffort } : {}),
                                      },
                                    },
                                  };
                                });
                              }}
                            />
                            {effortCap.mode === "configurable" ? (
                              <SimpleSelect
                                size="sm"
                                className="w-[135px] font-mono"
                                data-testid={`route-effort-${role}`}
                                title={t(language, "routing.effortTitle")}
                                value={
                                  rule.primary.reasoningEffort && efforts.includes(rule.primary.reasoningEffort)
                                    ? rule.primary.reasoningEffort
                                    : ""
                                }
                                onValueChange={(next) => {
                                  const eff = next as ReasoningEffort | "";
                                  updateDraft((base) => {
                                    const prevRule = base[role];
                                    const nextPrimary = { ...prevRule.primary };
                                    if (eff) nextPrimary.reasoningEffort = eff;
                                    else delete nextPrimary.reasoningEffort;
                                    return {
                                      ...base,
                                      [role]: { ...prevRule, primary: nextPrimary },
                                    };
                                  });
                                }}
                                options={[
                                  {
                                    value: "",
                                    label: `${t(language, "routing.defaultEffort")}${
                                      effortCap.defaultEffort ? ` (${effortLabel(language, effortCap.defaultEffort)})` : ""
                                    }`,
                                  },
                                  ...efforts.map((eff) => ({
                                    value: eff,
                                    label: effortLabel(language, eff),
                                  })),
                                ]}
                              />
                            ) : effortCap.mode === "locked" ? (
                              <span
                                className="inline-flex h-7 w-[135px] items-center justify-center overflow-hidden rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground"
                                data-testid={`route-effort-${role}-locked`}
                                title={`${lockedLabel} · ${t(language, "routing.effortLockedTitle")}`}
                              >
                                <span className="min-w-0 truncate">{lockedLabel}</span>
                              </span>
                            ) : (
                              <span
                                className="inline-flex h-7 w-[135px] items-center justify-center overflow-hidden rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
                                data-testid={`route-effort-${role}-unsupported`}
                              >
                                <span className="min-w-0 truncate">
                                  {t(language, "routing.effortUnsupportedLabel")}
                                </span>
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="border-t pt-2 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="xs muted">{t(language, "routing.fallbacksLabel")}</span>
                            <Button
                              size="xs"
                              variant="ghost"
                              type="button"
                              data-testid={`add-fallback-${role}`}
                              onClick={() => {
                                const fb = firstInstalledTarget();
                                updateDraft((base) => ({
                                  ...base,
                                  [role]: {
                                    ...base[role],
                                    fallbacks: [...base[role].fallbacks, fb],
                                  },
                                }));
                              }}
                            >
                              <Icon icon={Plus} size={14} /> {t(language, "routing.addFallback")}
                            </Button>
                          </div>
                          {rule.fallbacks.length === 0 ? (
                            <div className="xs muted">{t(language, "routing.noFallbacks")}</div>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {rule.fallbacks.map((fb, idx) => (
                                <div key={`${role}-fb-${idx}`} className="flex items-center gap-2">
                                  <span className="xs muted w-5">#{idx + 1}</span>
                                  <RoutingModelPicker
                                    testId={`route-fallback-${role}-${idx}`}
                                    harnesses={harnesses}
                                    value={`${fb.harness}::${fb.model}`}
                                    ariaLabel={`${role} fallback ${idx + 1}`}
                                    onChange={(key) => {
                                      const parsed = parseRunnerKey(key);
                                      if (!parsed) return;
                                      updateDraft((base) => {
                                        const nextFbs = [...base[role].fallbacks];
                                        nextFbs[idx] = { harness: parsed.harness as HarnessId, model: parsed.model };
                                        return {
                                          ...base,
                                          [role]: { ...base[role], fallbacks: nextFbs },
                                        };
                                      });
                                    }}
                                  />
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    type="button"
                                    aria-label={t(language, "routing.removeFallback")}
                                    onClick={() =>
                                      updateDraft((base) => ({
                                        ...base,
                                        [role]: {
                                          ...base[role],
                                          fallbacks: base[role].fallbacks.filter((_, i) => i !== idx),
                                        },
                                      }))
                                    }
                                  >
                                    <Icon icon={Trash2} size={14} />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-2.5">
                  <div className="flex flex-wrap items-center gap-4">
                    <Label className="flex items-center gap-2 text-[13px] font-normal">
                      <Checkbox
                        data-testid="routing-auto-review-checkbox"
                        checked={cfg.autoReview !== false}
                        onCheckedChange={(checked) =>
                          updateDraft((base) => ({ ...base, autoReview: Boolean(checked) }))
                        }
                      />
                      <span>{t(language, "routing.autoReviewLabel")}</span>
                    </Label>
                    <Label className="flex items-center gap-2 text-[13px] font-normal">
                      <Checkbox
                        data-testid="routing-auto-heal-checkbox"
                        checked={cfg.autoHeal !== false}
                        onCheckedChange={(checked) =>
                          updateDraft((base) => ({ ...base, autoHeal: Boolean(checked) }))
                        }
                      />
                      <span>{t(language, "routing.autoHealLabel")}</span>
                    </Label>
                  </div>
                </div>
              </DialogPanel>

              <DialogFooter>
                <Button variant="ghost" type="button" onClick={onClose}>
                  <Icon icon={X} size={14} /> {t(language, "common.cancel")}
                </Button>
                <AsyncButton
                  variant="default"
                  type="button"
                  data-testid="save-routing-btn"
                  disabled={busy}
                  onAction={saveRouting}
                >
                  <Icon icon={Save} size={14} /> {t(language, "routing.saveProject")}
                </AsyncButton>
              </DialogFooter>
            </>
          )}
        </div>
      ) : (
        <div data-testid="settings-pane-project" className="contents">
          <DialogPanel className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                <Icon icon={Globe} size={14} /> {t(language, "routing.global")}
              </div>
              <Alert variant="info">
                <Icon icon={Info} size={14} />
                <AlertDescription>{t(language, "routing.outputLanguageCallout")}</AlertDescription>
              </Alert>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                    {t(language, "routing.hubLangLabel")}
                  </Label>
                  <SimpleSelect
                    className="w-full"
                    data-testid="hub-output-language-select"
                    value={hubLangValue}
                    onValueChange={(next) =>
                      setModal((prev) =>
                        prev?.kind === "routing" ? { ...prev, hubLangDraft: next as OutputLanguage } : prev,
                      )
                    }
                    options={[
                      { value: "zh-CN", label: t(language, "routing.langZhDefault") },
                      { value: "en", label: t(language, "init.langEn") },
                      { value: "auto", label: t(language, "routing.langAuto") },
                    ]}
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-1.5">
                    <Label
                      className="text-xs text-muted-foreground font-normal"
                      htmlFor="hub-gitee-token-input"
                      title={t(language, "gitee.tokenTooltip")}
                    >
                      {t(language, "gitee.tokenLabel")}
                    </Label>
                    <Badge
                      variant={
                        m.clearGiteeToken
                          ? "secondary"
                          : hub?.giteeTokenConfigured
                            ? "success"
                            : "warning"
                      }
                      size="sm"
                      data-testid="hub-gitee-token-status"
                    >
                      <Icon
                        icon={
                          m.clearGiteeToken
                            ? Trash2
                            : hub?.giteeTokenConfigured
                              ? Check
                              : AlertTriangle
                        }
                        size={14}
                      />{" "}
                      {m.clearGiteeToken
                        ? t(language, "gitee.tokenClearOnSave")
                        : hub?.giteeTokenConfigured
                          ? t(language, "gitee.tokenConfigured", { masked: hub.giteeTokenMasked ?? "••••" })
                          : t(language, "gitee.tokenUnconfigured")}
                    </Badge>
                  </div>
                  <div className="flex gap-1.5">
                    <Input
                      id="hub-gitee-token-input"
                      type="password"
                      className="flex-1"
                      data-testid="hub-gitee-token-input"
                      value={giteeTokenValue}
                      placeholder={
                        hub?.giteeTokenConfigured
                          ? t(language, "gitee.tokenPlaceholderReplace")
                          : t(language, "gitee.tokenPlaceholderNew")
                      }
                      onChange={(e) =>
                        setModal((prev) =>
                          prev?.kind === "routing"
                            ? { ...prev, giteeTokenDraft: e.target.value, clearGiteeToken: false }
                            : prev,
                        )
                      }
                    />
                    {hub?.giteeTokenConfigured && !m.clearGiteeToken && (
                      <Button
                        variant="outline"
                        type="button"
                        data-testid="hub-gitee-token-clear"
                        onClick={() =>
                          setModal((prev) =>
                            prev?.kind === "routing"
                              ? { ...prev, giteeTokenDraft: "", clearGiteeToken: true }
                              : prev,
                          )
                        }
                      >
                        <Icon icon={X} size={14} /> {t(language, "gitee.tokenClear")}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {!noHubProject && project?.initialized && (
              <>
                <div className="border-t pt-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <strong className="text-[13px]">{t(language, "gitee.providerTitle")}</strong>
                      <SegmentedControl
                        size="sm"
                        aria-label={t(language, "gitee.providerTitle")}
                        render={
                          <RadioGroupPrimitive
                            className="flex items-center"
                            value={projProviderValue}
                            onValueChange={(next) => {
                              if (next === "github" || next === "gitee") {
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, projProviderDraft: next } : prev,
                                );
                              }
                            }}
                          />
                        }
                      >
                        <SegmentedControlItem
                          render={<RadioPrimitive.Root value="github" data-testid="project-provider-github" />}
                        >
                          GitHub
                        </SegmentedControlItem>
                        <SegmentedControlItem
                          render={<RadioPrimitive.Root value="gitee" data-testid="project-provider-gitee" />}
                        >
                          Gitee
                        </SegmentedControlItem>
                      </SegmentedControl>
                    </div>
                    {projProviderValue === "gitee"
                      ? giteeStatus && (
                          <Badge
                            variant={giteeStatus.ready ? "success" : "warning"}
                            size="sm"
                            data-testid="project-provider-status"
                          >
                            <Icon icon={giteeStatus.ready ? Check : AlertTriangle} size={14} />
                            {giteeStatus.ready
                              ? t(language, "gitee.statusReady", { account: giteeStatus.account ?? "authenticated" })
                              : formatGiteeStatusReason(language, giteeStatus)}
                          </Badge>
                        )
                      : githubStatus && (
                          <Badge
                            variant={githubStatus.ready ? "success" : "warning"}
                            size="sm"
                            data-testid="project-provider-status"
                          >
                            <Icon icon={githubStatus.ready ? Check : AlertTriangle} size={14} />
                            {githubStatus.ready
                              ? t(language, "gitee.statusGhReady", { account: githubStatus.account ?? "authenticated" })
                              : formatGitHubStatusReason(language, githubStatus)}
                          </Badge>
                        )}
                  </div>

                  {projProviderValue === "gitee" ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_150px]">
                      <div>
                        <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                          {t(language, "gitee.repoLabel")}
                        </Label>
                        <Input
                          size="sm"
                          data-testid="project-gitee-repo-input"
                          value={giteeRepoValue}
                          placeholder="owner/repo"
                          onChange={(e) =>
                            setModal((prev) =>
                              prev?.kind === "routing" ? { ...prev, giteeRepoDraft: e.target.value } : prev,
                            )
                          }
                        />
                      </div>
                      <div>
                        <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                          {t(language, "gitee.enterpriseLabel")}
                        </Label>
                        <Input
                          size="sm"
                          data-testid="project-gitee-enterprise-input"
                          value={giteeEnterpriseValue}
                          onChange={(e) =>
                            setModal((prev) =>
                              prev?.kind === "routing" ? { ...prev, giteeEnterpriseDraft: e.target.value } : prev,
                            )
                          }
                        />
                      </div>
                      <div>
                        <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                          {t(language, "gitee.baseBranchLabel")}
                        </Label>
                        <Input
                          size="sm"
                          data-testid="project-gitee-base-input"
                          value={giteeBaseValue}
                          placeholder="master"
                          onChange={(e) =>
                            setModal((prev) =>
                              prev?.kind === "routing" ? { ...prev, giteeBaseBranchDraft: e.target.value } : prev,
                            )
                          }
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mb-1.5 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px]">
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                            {t(language, "gitee.ghRepoLabel")}
                          </Label>
                          <Input
                            size="sm"
                            data-testid="project-github-repo-input"
                            value={ghRepoValue}
                            placeholder="owner/repo"
                            onChange={(e) =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, ghRepoDraft: e.target.value } : prev,
                              )
                            }
                          />
                        </div>
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                            {t(language, "gitee.baseBranchLabel")}
                          </Label>
                          <Input
                            size="sm"
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
                      <div className="flex flex-wrap items-center gap-4">
                        <Label className="flex items-center gap-2 text-[13px] font-normal">
                          <Checkbox
                            data-testid="project-github-autocreate"
                            checked={ghAutoCreateValue}
                            onCheckedChange={(checked) =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, ghAutoCreateDraft: Boolean(checked) } : prev,
                              )
                            }
                          />
                          <span>{t(language, "routing.ghAutoCreate")}</span>
                        </Label>
                        <Label className="flex items-center gap-2 text-[13px] font-normal">
                          <Checkbox
                            data-testid="project-github-autosync"
                            checked={ghAutoSyncValue}
                            onCheckedChange={(checked) =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, ghAutoSyncDraft: Boolean(checked) } : prev,
                              )
                            }
                          />
                          <span>{t(language, "routing.ghAutoSync")}</span>
                        </Label>
                      </div>
                    </>
                  )}
                </div>

                <div className="border-t pt-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-[13px]">{t(language, "routing.verificationTitle")}</strong>
                    <Label className="flex items-center gap-1.5 text-xs font-normal">
                      <Checkbox
                        data-testid="project-auto-screenshots"
                        checked={autoScreenshotsValue}
                        onCheckedChange={(checked) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, autoScreenshotsDraft: Boolean(checked) } : prev,
                          )
                        }
                      />
                      <span>{t(language, "routing.autoScreenshotsLabel")}</span>
                    </Label>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                        {t(language, "routing.projectLangLabel", { name: project.project?.name ?? "" })}
                      </Label>
                      <SimpleSelect
                        size="sm"
                        className="w-full"
                        data-testid="project-output-language-select"
                        value={projLangValue}
                        onValueChange={(next) =>
                          setModal((prev) =>
                            prev?.kind === "routing"
                              ? { ...prev, projLangDraft: next as OutputLanguage | "inherit" }
                              : prev,
                          )
                        }
                        options={[
                          { value: "inherit", label: t(language, "routing.inheritHub", { lang: savedHubLang }) },
                          { value: "zh-CN", label: t(language, "init.langZh") },
                          { value: "en", label: t(language, "init.langEn") },
                          { value: "auto", label: t(language, "routing.langAuto") },
                        ]}
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                        {t(language, "routing.fastCmdLabel")}
                      </Label>
                      <Input
                        size="sm"
                        data-testid="project-fast-cmd-input"
                        value={fastCmdValue}
                        placeholder={project.context?.fastCommand ?? t(language, "routing.fastCmdPlaceholder")}
                        onChange={(e) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, fastCmdDraft: e.target.value } : prev,
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                        {t(language, "routing.fullCmdLabel")}
                      </Label>
                      <Input
                        size="sm"
                        data-testid="project-full-cmd-input"
                        value={fullCmdValue}
                        placeholder={project.context?.fullCommand ?? t(language, "routing.fullCmdPlaceholder")}
                        onChange={(e) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, fullCmdDraft: e.target.value } : prev,
                          )
                        }
                      />
                    </div>
                  </div>
                </div>

                <div className="border-t pt-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-[13px]">{t(language, "routing.worktreeTitle")}</strong>
                    <Label className="flex items-center gap-1.5 text-xs font-normal">
                      <Checkbox
                        data-testid="project-worktree-enabled"
                        checked={worktreeEnabledValue}
                        onCheckedChange={(checked) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, worktreeEnabledDraft: Boolean(checked) } : prev,
                          )
                        }
                      />
                      <span>{t(language, "routing.worktreeEnabledLabel")}</span>
                    </Label>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                        {t(language, "routing.worktreeSetupScriptLabel")}
                      </Label>
                      <Input
                        size="sm"
                        data-testid="project-worktree-setup-script"
                        value={worktreeSetupScriptValue}
                        placeholder={t(language, "routing.worktreeSetupScriptPlaceholder")}
                        onChange={(e) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, worktreeSetupScriptDraft: e.target.value } : prev,
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                        {t(language, "routing.worktreeCopyFilesLabel")}
                      </Label>
                      <Input
                        size="sm"
                        data-testid="project-worktree-copy-files"
                        value={worktreeCopyFilesValue}
                        placeholder={t(language, "routing.worktreeCopyFilesPlaceholder")}
                        onChange={(e) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, worktreeCopyFilesDraft: e.target.value } : prev,
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </DialogPanel>

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onClose}>
              <Icon icon={X} size={14} /> {t(language, "common.cancel")}
            </Button>
            <AsyncButton
              variant="default"
              type="button"
              data-testid="save-project-btn"
              disabled={busy}
              onAction={saveSettings}
            >
              <Icon icon={Save} size={14} /> {t(language, "routing.saveProject")}
            </AsyncButton>
          </DialogFooter>
        </div>
      )}
    </ModalShell>
  );
}
