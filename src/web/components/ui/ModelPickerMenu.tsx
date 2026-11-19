import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import { Check, Search, Star } from "lucide-react";
import { t, type UiLanguage } from "../../i18n.ts";
import {
  filterRunnerModelOptions,
  matchesModelQuery,
  runnerModelSearchText,
  splitFavoriteRunnerModelOptions,
  type RunnerModelOption,
} from "../../state.ts";
import { useModelFavoritesStore } from "../../stores/modelFavoritesStore.ts";
import { useUiStore } from "../../stores/uiStore.ts";
import { cn } from "../../lib/utils.ts";
import { Icon } from "../Icon.tsx";

export interface ModelPickerShortcut {
  key: string;
  /** cmdk 搜索匹配文本 */
  value: string;
  content: ReactNode;
  selected: boolean;
  onSelect: () => void;
}

function tierTone(tier: string): string {
  if (tier === "sota") return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
  if (tier === "fast") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (tier === "review") return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400";
}

function ModelPickerRow({
  option,
  selected,
  favorite,
  showHarness,
  testIdPrefix,
  language,
  onSelect,
  onToggleFavorite,
}: {
  option: RunnerModelOption;
  selected: boolean;
  favorite: boolean;
  showHarness: boolean;
  testIdPrefix: string;
  language: UiLanguage;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  const favoriteLabel = t(language, favorite ? "runner.favoriteRemove" : "runner.favoriteAdd", {
    harness: option.harnessLabel,
    model: option.modelId,
  });
  const secondary =
    option.displayLabel !== option.modelId ? option.displayLabel : showHarness ? option.harnessLabel : "";
  return (
    <div className="flex items-center gap-1" data-testid={`${testIdPrefix}-row-${option.key}`}>
      <Command.Item
        value={runnerModelSearchText(option)}
        onSelect={onSelect}
        data-testid={`${testIdPrefix}-option-${option.key}`}
        className={cn(
          "min-w-0 flex-1 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer aria-selected:bg-[var(--accent-soft)]",
          selected && "font-semibold text-[var(--accent)]",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11.5px]">
            {showHarness ? `${option.harnessId} · ${option.modelId}` : option.modelId}
          </div>
          {secondary && (
            <div className="truncate text-[10.5px] text-[var(--muted)]">
              {showHarness && option.displayLabel !== option.modelId
                ? `${option.harnessLabel} · ${secondary}`
                : secondary}
            </div>
          )}
        </div>
        <span className="flex items-center gap-1 shrink-0">
          {option.preserved && <span className="badge warning">{t(language, "routing.preserved")}</span>}
          {option.unverified && <span className="badge neutral">{t(language, "routing.unverified")}</span>}
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] uppercase", tierTone(option.tier))}>
            {option.tier}
          </span>
          {selected && <Icon icon={Check} size={14} />}
        </span>
      </Command.Item>
      <button
        type="button"
        data-testid={`${testIdPrefix}-fav-${option.key}`}
        data-model-favorite={option.key}
        aria-label={favoriteLabel}
        aria-pressed={favorite}
        title={favoriteLabel}
        className={cn(
          "shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          favorite && "text-amber-500 dark:text-amber-400",
        )}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleFavorite();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          // 阻断 cmdk 根节点的 Enter 选中逻辑，让空格/回车只切换收藏。
          event.preventDefault();
          event.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Icon icon={Star} size={14} className={favorite ? "fill-current" : undefined} />
      </button>
    </div>
  );
}

/**
 * 工作台与配置弹窗共享的模型选择列表：搜索、收藏分组、普通 Harness 分组。
 * 收藏按钮独立于可选择项之外，切换收藏不会触发模型选择。
 */
export function ModelPickerMenu({
  options,
  selectedKey,
  onSelect,
  shortcuts = [],
  testIdPrefix,
  emptyText,
  favorites: favoritesOverride,
  onToggleFavorite: toggleFavoriteOverride,
  language: languageOverride,
}: {
  options: RunnerModelOption[];
  selectedKey: string;
  onSelect: (option: RunnerModelOption) => void;
  shortcuts?: ModelPickerShortcut[];
  testIdPrefix: string;
  emptyText?: string;
  favorites?: string[];
  onToggleFavorite?: (key: string) => void;
  language?: UiLanguage;
}) {
  const storeLanguage = useUiStore((s) => s.language);
  const language = languageOverride ?? storeLanguage;
  const storedFavorites = useModelFavoritesStore((state) => state.favorites);
  const storedToggleFavorite = useModelFavoritesStore((state) => state.toggleFavorite);
  const favorites = favoritesOverride ?? storedFavorites;
  const toggleFavorite = toggleFavoriteOverride ?? storedToggleFavorite;
  const [query, setQuery] = useState("");
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 收藏后条目会在“收藏/普通”分组间移动，重新挂载时把焦点还给同一个星标按钮。
  useEffect(() => {
    if (!pendingFocusKey) return;
    const root = rootRef.current;
    const target = root
      ? Array.from(root.querySelectorAll<HTMLButtonElement>("[data-model-favorite]")).find(
          (button) => button.dataset.modelFavorite === pendingFocusKey,
        )
      : undefined;
    target?.focus();
    setPendingFocusKey(null);
  }, [pendingFocusKey, favorites]);

  const toggleAndKeepFocus = (key: string) => {
    toggleFavorite(key);
    setPendingFocusKey(key);
  };

  const visibleShortcuts = useMemo(
    () => shortcuts.filter((shortcut) => matchesModelQuery(shortcut.value, query)),
    [shortcuts, query],
  );
  const visibleOptions = useMemo(() => filterRunnerModelOptions(options, query), [options, query]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const sections = useMemo(
    () => splitFavoriteRunnerModelOptions(visibleOptions, favoriteSet),
    [visibleOptions, favoriteSet],
  );
  const empty = visibleShortcuts.length === 0 && visibleOptions.length === 0;
  const resolvedEmptyText = emptyText ?? t(language, "runner.noMatch");

  return (
    <Command ref={rootRef} shouldFilter={false} className="flex flex-col max-h-[360px]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <Icon icon={Search} size={14} className="text-[var(--muted)] shrink-0" />
        <Command.Input
          data-testid={`${testIdPrefix}-search`}
          value={query}
          onValueChange={setQuery}
          placeholder={t(language, "runner.searchPlaceholder")}
          className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-[var(--muted)]"
        />
      </div>
      <Command.List className="overflow-y-auto p-1.5 flex-1">
        {empty && (
          <div data-testid={`${testIdPrefix}-empty`} className="py-6 text-center text-xs text-[var(--muted)]">
            {resolvedEmptyText}
          </div>
        )}
        {visibleShortcuts.length > 0 && (
          <Command.Group heading={t(language, "runner.quickPresets")} className="cmdk-group" data-testid={`${testIdPrefix}-shortcuts`}>
            {visibleShortcuts.map((shortcut) => (
              <Command.Item
                key={shortcut.key}
                value={shortcut.value}
                onSelect={() => shortcut.onSelect()}
                data-testid={`${testIdPrefix}-shortcut-${shortcut.key}`}
                className={cn(
                  "flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer aria-selected:bg-[var(--accent-soft)]",
                  shortcut.selected && "font-semibold text-[var(--accent)]",
                )}
              >
                <span>{shortcut.content}</span>
                {shortcut.selected && <Icon icon={Check} size={14} />}
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {sections.favorites.length > 0 && (
          <Command.Group heading={t(language, "runner.favoritesHeading")} className="cmdk-group" data-testid={`${testIdPrefix}-favorites`}>
            {sections.favorites.map((option) => (
              <ModelPickerRow
                key={option.key}
                option={option}
                selected={selectedKey === option.key}
                favorite
                showHarness
                testIdPrefix={testIdPrefix}
                language={language}
                onSelect={() => onSelect(option)}
                onToggleFavorite={() => toggleAndKeepFocus(option.key)}
              />
            ))}
          </Command.Group>
        )}
        {sections.groups.map((group) => (
          <Command.Group
            key={group.key}
            heading={group.label}
            className="cmdk-group"
            data-testid={`${testIdPrefix}-group-${group.key}`}
          >
            {group.items.map((option) => (
              <ModelPickerRow
                key={option.key}
                option={option}
                selected={selectedKey === option.key}
                favorite={favoriteSet.has(option.key)}
                showHarness={false}
                testIdPrefix={testIdPrefix}
                language={language}
                onSelect={() => onSelect(option)}
                onToggleFavorite={() => toggleAndKeepFocus(option.key)}
              />
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command>
  );
}