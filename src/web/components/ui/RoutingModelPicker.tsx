import { useMemo, useState } from "react";
import {
  Content as PopoverContent,
  Portal as PopoverPortal,
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
} from "@radix-ui/react-popover";
import { ChevronsUpDown } from "lucide-react";
import type { HarnessInfo } from "../../../hub/types.ts";
import { t, type UiLanguage } from "../../i18n.ts";
import { collectRoutingModelOptions } from "../../state.ts";
import { useUiStore } from "../../stores/uiStore.ts";
import { Icon } from "../Icon.tsx";
import { ModelPickerMenu } from "./ModelPickerMenu.tsx";

/**
 * 路由配置弹窗的主模型选择器：可搜索、可收藏，仍保留未安装 Harness 与列表外已配置模型。
 * 原生 select 保持同步并隐藏，供键盘/自动化选择与既有行为使用。
 */
export function RoutingModelPicker({
  testId,
  harnesses,
  value,
  onChange,
  ariaLabel,
  language: languageOverride,
}: {
  testId: string;
  harnesses: HarnessInfo[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
  language?: UiLanguage;
}) {
  const storeLanguage = useUiStore((s) => s.language);
  const language = languageOverride ?? storeLanguage;
  const [open, setOpen] = useState(false);
  const options = useMemo(() => collectRoutingModelOptions(harnesses, value, language), [harnesses, value, language]);
  const selected = options.find((option) => option.key === value);
  const resolvedAriaLabel = ariaLabel ?? t(language, "routing.primaryModelAria", { stage: "" }).trim();

  return (
    <>
      <select
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        data-field="route-model-select"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.harnessId} · {option.modelId}
            {option.unverified ? ` · ${t(language, "routing.unverified")}` : ""}
            {option.preserved ? ` · ${t(language, "routing.preserved")}` : ""}
          </option>
        ))}
      </select>
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="btn xs routing-picker-trigger inline-flex items-center gap-1.5"
            data-testid={`${testId}-trigger`}
            aria-label={t(language, "routing.pickerAriaCurrent", {
              label: resolvedAriaLabel,
              current: selected?.label ?? value,
            })}
            title={selected?.label ?? value}
          >
            <span className="truncate min-w-0 font-mono text-[11.5px]">{selected?.label ?? value}</span>
            <Icon icon={ChevronsUpDown} size={14} className="shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            align="start"
            sideOffset={6}
            className="z-[80] w-[360px] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-0 overflow-hidden"
          >
            <ModelPickerMenu
              options={options}
              selectedKey={value}
              testIdPrefix={testId}
              language={language}
              onSelect={(option) => {
                // 与原生 select 的 change 语义一致：值未变化时不触发变更，避免重复点选清除推理强度。
                if (option.key !== value) onChange(option.key);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </>
  );
}