import React, { useMemo, useRef, useState } from "react";
import { ChevronsUpDown, Cpu, Gauge } from "lucide-react";
import type { AgentAction } from "../../../core/types.ts";
import type { ReasoningEffort } from "../../../hub/types.ts";
import { t } from "../../i18n.ts";
import { resolveEffectiveRouting, useHubStateQuery, useProjectQuery } from "../../queries.ts";
import {
  activeRunnerChoice,
  collectModelOptions,
  effortLabel,
  getModelEffortCapability,
} from "../../state.ts";
import { useDraftStore } from "../../stores/draftStore.ts";
import { useUiStore } from "../../stores/uiStore.ts";
import { Icon } from "../Icon.tsx";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { ModelPickerMenu, type ModelPickerShortcut } from "./ModelPickerMenu.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover.tsx";
import { SimpleSelect } from "./select.tsx";

export function ModelRunnerBar({
  stageAction,
  testId,
  includeManualCopy = false,
}: {
  stageAction: AgentAction;
  testId: string;
  includeManualCopy?: boolean;
}) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId ?? hub?.activeProjectId ?? null);
  const harnesses = hub?.harnesses ?? [];
  const routing = resolveEffectiveRouting(hub, project);

  const override = useDraftStore((s) => s.runnerOverrides[stageAction]);
  const selectedRunnerKey = override?.key ?? "";
  const selectedEffort = override?.effort ?? "";
  const setSelectedRunnerKey = useDraftStore((s) => s.setSelectedRunnerKey);
  const setSelectedEffort = useDraftStore((s) => s.setSelectedEffort);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  const modelOptions = useMemo(() => collectModelOptions(harnesses), [harnesses]);
  const choice = activeRunnerChoice(selectedRunnerKey, routing, stageAction, selectedEffort);
  const selectedKey =
    selectedRunnerKey === "manual_copy"
      ? "manual_copy"
      : selectedRunnerKey || (choice.harness && choice.model ? `${choice.harness}::${choice.model}` : "");

  const effortCap = useMemo(
    () => getModelEffortCapability(harnesses, choice.harness, choice.model),
    [harnesses, choice.harness, choice.model],
  );
  const efforts = effortCap.efforts;
  const lockedEffort = effortCap.defaultEffort ?? efforts[0];
  const effectiveDefaultEffort = choice.effort ?? effortCap.defaultEffort;
  const effortValue =
    selectedEffort && efforts.includes(selectedEffort) ? selectedEffort : "";

  const shortcuts = useMemo<ModelPickerShortcut[]>(() => {
    const items: ModelPickerShortcut[] = [
      {
        key: "default",
        value: "__auto__ 默认路由 自动路由 auto routing default",
        content: `${t(language, includeManualCopy ? "runner.autoRoute" : "runner.defaultRoute")}${
          choice.harness ? ` (${choice.harness}/${choice.model ?? ""})` : ""
        }`,
        selected: selectedRunnerKey === "",
        onSelect: () => {
          if (selectedRunnerKey !== "") {
            setSelectedRunnerKey("", stageAction);
          }
          setOpen(false);
        },
      },
    ];
    if (includeManualCopy) {
      items.push({
        key: "manual_copy",
        value: "manual_copy 仅生成提示词 手动复制 manual copy prompt",
        content: t(language, "runner.manual"),
        selected: selectedRunnerKey === "manual_copy",
        onSelect: () => {
          if (selectedRunnerKey !== "manual_copy") {
            setSelectedRunnerKey("manual_copy", stageAction);
          }
          setOpen(false);
        },
      });
    }
    return items;
  }, [language, includeManualCopy, choice.harness, choice.model, selectedRunnerKey, setSelectedRunnerKey, stageAction]);

  const currentDisplay =
    selectedRunnerKey === "manual_copy"
      ? t(language, "runner.manual")
      : selectedRunnerKey
        ? `${choice.harness}/${choice.model}`
        : choice.harness
          ? `${t(language, includeManualCopy ? "runner.auto" : "runner.default")} (${choice.harness}/${choice.model ?? ""})`
          : t(language, includeManualCopy ? "runner.autoRoute" : "runner.defaultRoute");

  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap">
      {/* Keep native select synced & accessible for E2E test selectors */}
      <select
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        data-field="runner-select"
        data-testid={testId}
        value={selectedKey}
        onChange={(e) => {
          setSelectedRunnerKey(e.target.value, stageAction);
        }}
      >
        <option value="">
          {t(language, includeManualCopy ? "runner.autoRoute" : "runner.defaultRoute")}
          {choice.harness ? ` (${choice.harness}/${choice.model ?? ""})` : ""}
        </option>
        {modelOptions.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
        {includeManualCopy && <option value="manual_copy">{t(language, "runner.manual")}</option>}
      </select>

      <Popover open={open} onOpenChange={setOpen}>
        {/*
         * 引用稳定：锚点放在独立的 span 上，交互按钮只承载触发与焦点。
         * 这样按钮在无关重新渲染或局部替换时不会反复触发位置重算循环。
         */}
        <span ref={anchorRef} className="inline-flex min-w-0 max-w-full" data-testid={`${testId}-anchor`}>
          <PopoverTrigger
            render={
              <Button
                ref={triggerRef}
                type="button"
                variant="outline"
                size="sm"
                className="model-runner-trigger max-w-[235px] min-w-0 shrink justify-start"
                data-testid={`${testId}-trigger`}
                title={t(language, "runner.current", { model: currentDisplay })}
              >
                <Icon icon={Cpu} size={14} className="shrink-0 opacity-70" />
                <span className="truncate min-w-0 font-mono text-[11.5px]">{currentDisplay}</span>
                <Icon icon={ChevronsUpDown} size={14} className="shrink-0 opacity-60" />
              </Button>
            }
          />
        </span>
        <PopoverPopup
          align="end"
          anchor={anchorRef}
          className="w-[340px] rounded-xl p-0 overflow-hidden"
          finalFocus={triggerRef}
          positionerClassName="z-[80]"
          sideOffset={6}
          viewportClassName="p-0"
        >
          <ModelPickerMenu
            options={modelOptions}
            selectedKey={selectedKey}
            shortcuts={shortcuts}
            testIdPrefix={testId}
            onSelect={(option) => {
              if (option.key !== selectedRunnerKey) {
                setSelectedRunnerKey(option.key, stageAction);
              }
              setOpen(false);
            }}
          />
        </PopoverPopup>
      </Popover>

      {/* Reasoning Effort selector: 3-state adaptive (configurable / locked / unsupported) */}
      {selectedRunnerKey !== "manual_copy" && effortCap.mode === "configurable" && (
        <div className="inline-flex items-center gap-1" title={t(language, "runner.effortTitle")}>
          <span className="hidden sm:inline-flex items-center text-muted-foreground">
            <Icon icon={Gauge} size={14} />
          </span>
          <SimpleSelect
            className="w-auto min-w-[96px] font-mono text-xs"
            data-field="effort-select"
            data-testid={`${testId}-effort`}
            options={[
              {
                value: "",
                label: `${t(language, "runner.effortDefault")}${effectiveDefaultEffort && !effortValue ? ` (${effectiveDefaultEffort})` : ""}`,
              },
              ...efforts.map((eff) => ({
                value: eff,
                label: effortLabel(language, eff),
              })),
            ]}
            size="sm"
            value={effortValue}
            onValueChange={(next) => setSelectedEffort(next as ReasoningEffort | "", stageAction)}
          />
        </div>
      )}
      {selectedRunnerKey !== "manual_copy" && effortCap.mode === "locked" && (
        <Badge
          variant="outline"
          className="h-7 gap-1 px-2 font-mono text-xs text-muted-foreground"
          data-testid={`${testId}-effort-locked`}
          title={t(language, "runner.effortLockedTitle")}
        >
          <Icon icon={Gauge} size={14} />
          <span>
            {t(language, "runner.effortLockedLabel", {
              effort: lockedEffort
                ? effortLabel(language, lockedEffort)
                : t(language, "runner.effortBuiltin"),
            })}
          </span>
        </Badge>
      )}
    </div>
  );
}