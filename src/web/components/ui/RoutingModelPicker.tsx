import { useMemo, useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import type { HarnessInfo } from "../../../hub/types.ts";
import { t, type UiLanguage } from "../../i18n.ts";
import { collectRoutingModelOptions } from "../../state.ts";
import { useUiStore } from "../../stores/uiStore.ts";
import { Icon } from "../Icon.tsx";
import { Button } from "./button.tsx";
import { ModelPickerMenu } from "./ModelPickerMenu.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover.tsx";

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
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
      <Popover open={open} onOpenChange={setOpen}>
        {/* 锚点与触发按钮分离，保持同一锚点节点在配置弹窗重新渲染期间引用稳定。 */}
        <span ref={anchorRef} className="inline-flex min-w-0 max-w-full" data-testid={`${testId}-anchor`}>
          <PopoverTrigger
            render={
              <Button
                ref={triggerRef}
                type="button"
                variant="outline"
                size="xs"
                className="routing-picker-trigger w-[230px] max-w-[280px] min-w-0 shrink justify-between"
                data-testid={`${testId}-trigger`}
                aria-label={t(language, "routing.pickerAriaCurrent", {
                  label: resolvedAriaLabel,
                  current: selected?.label ?? value,
                })}
                title={selected?.label ?? value}
              >
                <span className="truncate min-w-0 font-mono text-[11.5px]">{selected?.label ?? value}</span>
                <Icon icon={ChevronsUpDown} size={14} className="shrink-0 opacity-60" />
              </Button>
            }
          />
        </span>
        <PopoverPopup
          align="start"
          anchor={anchorRef}
          className="w-[360px] rounded-xl p-0 overflow-hidden"
          finalFocus={triggerRef}
          positionerClassName="z-[80]"
          sideOffset={6}
          viewportClassName="p-0"
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
        </PopoverPopup>
      </Popover>
    </>
  );
}