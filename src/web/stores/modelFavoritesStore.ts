import { create } from "zustand";

/** 收藏以“一条一个键”保存，键存在即已收藏；避免整表读改写造成跨标签页并发覆盖。 */
export const MODEL_FAVORITE_KEY_PREFIX = "wb-model-favorite::";

interface StorageLike {
  readonly length: number;
  key: (index: number) => string | null;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface ModelFavoritesState {
  favorites: string[];
  toggleFavorite: (key: string) => void;
}

/**
 * 归一化 `harnessId::modelId` 收藏键；非法条目（非字符串、缺少分隔符、空片段）返回 null。
 * 同名模型在不同 Harness 下因 Harness 前缀不同而分别记录。
 */
export function normalizeModelFavoriteKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  const harness = key.slice(0, separator);
  const model = key.slice(separator + 2);
  if (!harness || !model) return null;
  return `${harness}::${model}`;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 是否为收藏条目的存储键（含 `clear()` 产生的 null 视为相关事件）。 */
export function isModelFavoritesStorageKey(key: string | null | undefined): boolean {
  return key === null || (typeof key === "string" && key.startsWith(MODEL_FAVORITE_KEY_PREFIX));
}

/** 读取失败返回 null，以便调用方区分“确实为空”和“无法读取”。 */
function readModelFavorites(storage: StorageLike | null): string[] | null {
  if (!storage) return [];
  try {
    const names: string[] = [];
    const total = storage.length;
    for (let i = 0; i < total; i += 1) {
      const name = storage.key(i);
      if (typeof name === "string" && name.startsWith(MODEL_FAVORITE_KEY_PREFIX)) {
        names.push(name);
      }
    }
    const seen = new Set<string>();
    const favorites: string[] = [];
    for (const name of names) {
      const key = normalizeModelFavoriteKey(name.slice(MODEL_FAVORITE_KEY_PREFIX.length));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      favorites.push(key);
    }
    return favorites.sort();
  } catch {
    return null;
  }
}

/**
 * 枚举本地存储中的收藏集合。非法键（缺少分隔符、空片段）忽略；
 * 集合顺序不参与展示排序，界面始终按各入口原有选项顺序展示。
 */
export function loadModelFavorites(storage: StorageLike | null = browserStorage()): string[] {
  return readModelFavorites(storage) ?? [];
}

/** 只写入或删除目标条目自己的键；返回是否成功持久化。 */
export function persistModelFavorite(
  entry: string,
  favorited: boolean,
  storage: StorageLike | null = browserStorage(),
): boolean {
  const key = normalizeModelFavoriteKey(entry);
  if (!key || !storage) return false;
  try {
    if (favorited) storage.setItem(`${MODEL_FAVORITE_KEY_PREFIX}${key}`, "1");
    else storage.removeItem(`${MODEL_FAVORITE_KEY_PREFIX}${key}`);
    return true;
  } catch {
    return false;
  }
}

export function createModelFavoritesStore(storage: StorageLike | null = browserStorage()) {
  return create<ModelFavoritesState>((set, get) => ({
    favorites: loadModelFavorites(storage),
    toggleFavorite: (key) => {
      const normalized = normalizeModelFavoriteKey(key);
      if (!normalized) return;
      const current = get().favorites;
      const favorited = !current.includes(normalized);
      const persisted = persistModelFavorite(normalized, favorited, storage);
      const latest = persisted ? readModelFavorites(storage) : null;
      if (latest) {
        // 成功后重读，合并在写入期间其他标签页产生的收藏变化。
        set({ favorites: latest });
        return;
      }
      // 写入失败（隐私模式/配额不足）时保持当前页面可用，刷新后不保证保留。
      set({
        favorites: favorited
          ? [...current, normalized]
          : current.filter((entry) => entry !== normalized),
      });
    },
  }));
}

export const useModelFavoritesStore = createModelFavoritesStore();

/**
 * 跨标签页同步：任意收藏键（或 clear）变化时从存储全量重读，事件处理不回写存储。
 * 存储是唯一事实来源，各页面最终收敛一致。
 */
export function applyModelFavoritesStorageEvent(
  event: { key?: string | null },
  store: Pick<ReturnType<typeof createModelFavoritesStore>, "setState"> = useModelFavoritesStore,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (event.key === undefined) return false;
  if (!isModelFavoritesStorageKey(event.key)) return false;
  const latest = readModelFavorites(storage);
  if (latest === null) return false;
  store.setState({ favorites: latest });
  return true;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    applyModelFavoritesStorageEvent(event);
  });
}