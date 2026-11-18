import React, { useMemo, useState } from "react";
import {
  Content as PopoverContent,
  Portal as PopoverPortal,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Cpu, Gauge, Search } from "lucide-react";
import type { AgentAction } from "../../../core/types.ts";
import type { ReasoningEffort } from "../../../hub/types.ts";
import { cn } from "../../lib/utils.ts";
import { useHubStateQuery } from "../../queries.ts";
import {
  activeRunnerChoice,
  collectModelOptions,
  EFFORT_LABELS,
  getModelEffortCapability,
} from "../../state.ts";
import { useDraftStore } from "../../stores/draftStore.ts";
import { Icon } from "../Icon.tsx";

export function ModelRunnerBar({
  stageAction,
  testId,
  includeManualCopy = false,
}: {
  stageAction: AgentAction;
  testId: string;
  includeManualCopy?: boolean;
}) {
  const { data: hub } = useHubStateQuery();
  const harnesses = hub?.harnesses ?? [];
  const routing = hub?.routing ?? null;

  const override = useDraftStore((s) => s.runnerOverrides[stageAction]);
  const selectedRunnerKey = override?.key ?? "";
  const selectedEffort = override?.effort ?? "";
  const setSelectedRunnerKey = useDraftStore((s) => s.setSelectedRunnerKey);
  const setSelectedEffort = useDraftStore((s) => s.setSelectedEffort);

  const [open, setOpen] = useState(false);

  const modelOptions = useMemo(() => collectModelOptions(harnesses), [harnesses]);
  const choice = activeRunnerChoice(selectedRunnerKey, routing, stageAction, selectedEffort);
  const selectedKey =
    selectedRunnerKey === "manual_copy"
      ? "manual_copy"
      : selectedRunnerKey || (choice.harness && choice.model ? `${choice.harness}::${choice.model}` : "");

  const groupedOptions = useMemo(() => {
    const groups = new Map<string, { label: string; items: typeof modelOptions }>();
    for (const o of modelOptions) {
      let g = groups.get(o.harnessId);
      if (!g) {
        g = { label: o.harnessLabel, items: [] };
        groups.set(o.harnessId, g);
      }
      g.items.push(o);
    }
    return Array.from(groups.values());
  }, [modelOptions]);

  const effortCap = useMemo(
    () => getModelEffortCapability(harnesses, choice.harness, choice.model),
    [harnesses, choice.harness, choice.model],
  );
  const efforts = effortCap.efforts;
  const effectiveDefaultEffort = choice.effort ?? effortCap.defaultEffort;
  const effortValue =
    selectedEffort && efforts.includes(selectedEffort) ? selectedEffort : "";

  const currentDisplay =
    selectedRunnerKey === "manual_copy"
      ? "仅生成提示词 (手动复制)"
      : selectedRunnerKey
        ? `${choice.harness}/${choice.model}`
        : choice.harness
          ? `${includeManualCopy ? "自动" : "默认"} (${choice.harness}/${choice.model ?? ""})`
          : includeManualCopy
            ? "自动路由"
            : "默认路由";

  const tierTone = (tier: string) => {
    if (tier === "sota") return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
    if (tier === "fast") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    if (tier === "review") return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
    return "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400";
  };

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
          {includeManualCopy ? "自动路由" : "默认路由"}
          {choice.harness ? ` (${choice.harness}/${choice.model ?? ""})` : ""}
        </option>
        {modelOptions.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
        {includeManualCopy && <option value="manual_copy">仅生成提示词 (手动复制)</option>}
      </select>

      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="btn xs inline-flex items-center gap-1.5 max-w-[235px]"
            data-testid={`${testId}-trigger`}
            title={`当前模型：${currentDisplay}`}
          >
            <Icon icon={Cpu} size={14} className="shrink-0 opacity-70" />
            <span className="truncate font-mono text-[11.5px]">{currentDisplay}</span>
            <Icon icon={ChevronsUpDown} size={14} className="shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="z-[80] w-[340px] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-0 overflow-hidden"
          >
            <Command className="flex flex-col max-h-[360px]">
              <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
                <Icon icon={Search} size={14} className="text-[var(--muted)] shrink-0" />
                <Command.Input
                  placeholder="搜索模型 / Harness / Provider..."
                  className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-[var(--muted)]"
                />
              </div>
              <Command.List className="overflow-y-auto p-1.5 flex-1">
                <Command.Empty className="py-6 text-center text-xs text-[var(--muted)]">
                  未找到匹配的模型
                </Command.Empty>
                <Command.Group heading="快捷策略" className="cmdk-group">
                  <Command.Item
                    value="__auto__ 默认路由 自动路由"
                    onSelect={() => {
                      setSelectedRunnerKey("", stageAction);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer aria-selected:bg-[var(--accent-soft)]",
                      selectedRunnerKey === "" && "font-semibold text-[var(--accent)]",
                    )}
                  >
                    <span>
                      {includeManualCopy ? "自动路由" : "默认路由"}
                      {choice.harness ? ` (${choice.harness}/${choice.model})` : ""}
                    </span>
                    {selectedRunnerKey === "" && <Icon icon={Check} size={14} />}
                  </Command.Item>
                  {includeManualCopy && (
                    <Command.Item
                      value="manual_copy 仅生成提示词 手动复制"
                      onSelect={() => {
                        setSelectedRunnerKey("manual_copy", stageAction);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer aria-selected:bg-[var(--accent-soft)]",
                        selectedRunnerKey === "manual_copy" && "font-semibold text-[var(--accent)]",
                      )}
                    >
                      <span>仅生成提示词 (手动复制)</span>
                      {selectedRunnerKey === "manual_copy" && <Icon icon={Check} size={14} />}
                    </Command.Item>
                  )}
                </Command.Group>

                {groupedOptions.map((g) => (
                  <Command.Group key={g.label} heading={g.label} className="cmdk-group">
                    {g.items.map((o) => (
                      <Command.Item
                        key={o.key}
                        value={`${o.harnessId} ${o.harnessLabel} ${o.modelId} ${o.displayLabel} ${o.provider ?? ""}`}
                        onSelect={() => {
                          setSelectedRunnerKey(o.key, stageAction);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer aria-selected:bg-[var(--accent-soft)]",
                          selectedKey === o.key && "font-semibold text-[var(--accent)]",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-[11.5px]">{o.modelId}</div>
                          {o.displayLabel !== o.modelId && (
                            <div className="truncate text-[10.5px] text-[var(--muted)]">{o.displayLabel}</div>
                          )}
                        </div>
                        <span className={cn("px-1.5 py-0.5 rounded text-[10px] uppercase shrink-0", tierTone(o.tier))}>
                          {o.tier}
                        </span>
                        {selectedKey === o.key && <Icon icon={Check} size={14} className="shrink-0" />}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
            </Command>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>

      {/* Reasoning Effort selector: 3-state adaptive (configurable / locked / unsupported) */}
      {selectedRunnerKey !== "manual_copy" && effortCap.mode === "configurable" && (
        <div className="inline-flex items-center gap-1" title="模型推理强度 (Reasoning Effort)">
          <span className="hidden sm:inline-flex items-center text-[var(--muted)]">
            <Icon icon={Gauge} size={14} />
          </span>
          <select
            className="select xs font-mono"
            data-field="effort-select"
            data-testid={`${testId}-effort`}
            value={effortValue}
            onChange={(e) => setSelectedEffort(e.target.value as ReasoningEffort | "", stageAction)}
          >
            <option value="">
              默认强度{effectiveDefaultEffort && !effortValue ? ` (${effectiveDefaultEffort})` : ""}
            </option>
            {efforts.map((eff) => (
              <option key={eff} value={eff}>
                {EFFORT_LABELS[eff] ?? eff}
              </option>
            ))}
          </select>
        </div>
      )}
      {selectedRunnerKey !== "manual_copy" && effortCap.mode === "locked" && (
        <div
          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2,transparent)] text-[11px] font-mono text-[var(--muted)]"
          data-testid={`${testId}-effort-locked`}
          title="该模型变体已内置固定推理强度，不可单独覆盖"
        >
          <Icon icon={Gauge} size={14} />
          <span>固定: {effortCap.defaultEffort ?? efforts[0] ?? "内置"}</span>
        </div>
      )}
    </div>
  );
}
