import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiscoveredModel, HarnessInfo } from "../../src/hub/types.ts";
import { ModelPickerMenu } from "../../src/web/components/ui/ModelPickerMenu.tsx";
import { RoutingModelPicker } from "../../src/web/components/ui/RoutingModelPicker.tsx";
import {
  collectModelOptions,
  collectRoutingModelOptions,
  filterRunnerModelOptions,
  splitFavoriteRunnerModelOptions,
} from "../../src/web/state.ts";
import {
  MODEL_FAVORITE_KEY_PREFIX,
  applyModelFavoritesStorageEvent,
  createModelFavoritesStore,
  isModelFavoritesStorageKey,
  loadModelFavorites,
  normalizeModelFavoriteKey,
  persistModelFavorite,
  useModelFavoritesStore,
} from "../../src/web/stores/modelFavoritesStore.ts";

function model(id: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { id, tier: "balanced", source: "detected", ...extra };
}

function harness(
  id: HarnessInfo["id"],
  label: string,
  installed: boolean,
  models: DiscoveredModel[],
): HarnessInfo {
  return {
    id,
    label,
    subscription: `${label}-plan`,
    installed,
    executable: installed ? `/usr/bin/${id}` : null,
    models,
    defaultModel: models[0]?.id ?? null,
    detectedAt: 0,
  };
}

const HARNESSES: HarnessInfo[] = [
  harness("codex", "Codex", true, [
    model("gpt-6.1-sol", { label: "GPT-6.1 Sol", provider: "openai" }),
    model("gpt-6.1-mini", { label: "GPT-6.1 Mini" }),
  ]),
  harness("omp", "Oh My Pi", true, [model("gpt-6.1-sol", { label: "Sol via OMP" }), model("claude-x")]),
  harness("opencode", "OpenCode", false, [
    model("opencode/free", { label: "免费模型", source: "builtin" }),
  ]),
];

interface FakeStorage {
  readonly length: number;
  key: (index: number) => string | null;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function memoryStorage(
  initial: Record<string, string> = {},
  behavior: { failRead?: boolean; failWrite?: boolean } = {},
): FakeStorage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      if (behavior.failRead) throw new Error("storage read blocked");
      return data.size;
    },
    key(index) {
      if (behavior.failRead) throw new Error("storage read blocked");
      return Array.from(data.keys())[index] ?? null;
    },
    getItem(key) {
      if (behavior.failRead) throw new Error("storage read blocked");
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (behavior.failWrite) throw new Error("storage write blocked");
      data.set(key, value);
    },
    removeItem(key) {
      if (behavior.failWrite) throw new Error("storage write blocked");
      data.delete(key);
    },
  };
}

function favoriteStorageKey(entry: string): string {
  return `${MODEL_FAVORITE_KEY_PREFIX}${entry}`;
}

beforeEach(() => {
  useModelFavoritesStore.setState({ favorites: [] });
});

describe("收藏键与逐键存储", () => {
  test("收藏键归一化区分 Harness 并拒绝非法条目", () => {
    expect(normalizeModelFavoriteKey(1)).toBeNull();
    expect(normalizeModelFavoriteKey("bad")).toBeNull();
    expect(normalizeModelFavoriteKey("::model")).toBeNull();
    expect(normalizeModelFavoriteKey("harness::")).toBeNull();
    expect(normalizeModelFavoriteKey("  codex::gpt-6.1-sol  ")).toBe("codex::gpt-6.1-sol");
    expect(normalizeModelFavoriteKey("codex::gpt-6.1-sol")).not.toBe(
      normalizeModelFavoriteKey("omp::gpt-6.1-sol"),
    );
    expect(isModelFavoritesStorageKey(favoriteStorageKey("codex::gpt"))).toBe(true);
    expect(isModelFavoritesStorageKey(null)).toBe(true);
    expect(isModelFavoritesStorageKey("wb-theme")).toBe(false);
  });

  test("从逐键存储枚举收藏，忽略旧版整表键、无关键与非法键", () => {
    const storage = memoryStorage({
      [favoriteStorageKey("codex::gpt-6.1-sol")]: "1",
      [favoriteStorageKey("omp::gpt-6.1-sol")]: "1",
      [favoriteStorageKey("bad")]: "1",
      [favoriteStorageKey("::model")]: "1",
      [favoriteStorageKey("harness::")]: "1",
      "wb-model-favorites": JSON.stringify(["qodercn::legacy-model"]),
      "wb-theme": "dark",
    });
    expect(loadModelFavorites(storage)).toEqual(["codex::gpt-6.1-sol", "omp::gpt-6.1-sol"]);
  });

  test("存储不可用或读取异常时安全回退为空集合", () => {
    expect(loadModelFavorites(null)).toEqual([]);
    expect(loadModelFavorites(memoryStorage({ [favoriteStorageKey("codex::gpt")]: "1" }, { failRead: true }))).toEqual(
      [],
    );
  });

  test("只写入或删除目标收藏键，失败时不抛出", () => {
    const storage = memoryStorage();
    expect(persistModelFavorite("codex::gpt-6.1-sol", true, storage)).toBe(true);
    expect(storage.getItem(favoriteStorageKey("codex::gpt-6.1-sol"))).toBe("1");
    expect(persistModelFavorite("omp::gpt-6.1-sol", true, storage)).toBe(true);
    expect(loadModelFavorites(storage)).toEqual(["codex::gpt-6.1-sol", "omp::gpt-6.1-sol"]);

    expect(persistModelFavorite("codex::gpt-6.1-sol", false, storage)).toBe(true);
    expect(storage.getItem(favoriteStorageKey("codex::gpt-6.1-sol"))).toBeNull();
    expect(loadModelFavorites(storage)).toEqual(["omp::gpt-6.1-sol"]);

    expect(persistModelFavorite("bad", true, storage)).toBe(false);
    expect(persistModelFavorite("codex::gpt", true, null)).toBe(false);
    expect(() => persistModelFavorite("codex::gpt", true, memoryStorage({}, { failWrite: true }))).not.toThrow();
  });
});

describe("共享收藏 store", () => {
  test("初始化读取现有收藏，切换后只改目标键", () => {
    const storage = memoryStorage({ [favoriteStorageKey("codex::gpt-6.1-sol")]: "1" });
    const store = createModelFavoritesStore(storage);
    expect(store.getState().favorites).toEqual(["codex::gpt-6.1-sol"]);

    store.getState().toggleFavorite("omp::gpt-6.1-sol");
    expect(store.getState().favorites).toEqual(["codex::gpt-6.1-sol", "omp::gpt-6.1-sol"]);
    expect(storage.getItem(favoriteStorageKey("codex::gpt-6.1-sol"))).toBe("1");

    store.getState().toggleFavorite("codex::gpt-6.1-sol");
    expect(store.getState().favorites).toEqual(["omp::gpt-6.1-sol"]);
    expect(storage.getItem(favoriteStorageKey("codex::gpt-6.1-sol"))).toBeNull();
  });

  test("写入失败时当前页面仍可收藏，读取失败时回退空集合", () => {
    const failingWrite = memoryStorage({}, { failWrite: true });
    const store = createModelFavoritesStore(failingWrite);
    expect(() => store.getState().toggleFavorite("codex::gpt-6.1-sol")).not.toThrow();
    expect(store.getState().favorites).toEqual(["codex::gpt-6.1-sol"]);
    store.getState().toggleFavorite("codex::gpt-6.1-sol");
    expect(store.getState().favorites).toEqual([]);

    const failingRead = createModelFavoritesStore(memoryStorage({}, { failRead: true }));
    expect(failingRead.getState().favorites).toEqual([]);
    failingRead.getState().toggleFavorite("omp::claude-x");
    expect(failingRead.getState().favorites).toEqual(["omp::claude-x"]);
  });

  test("两页并发收藏不同模型：写入互不覆盖，事件同步后双方与刷新结果一致", () => {
    const storage = memoryStorage();
    const tabA = createModelFavoritesStore(storage);
    const tabB = createModelFavoritesStore(storage);

    // 复刻审查时序：两页都在对方写入前基于自身内存操作，先完成两次写入。
    tabA.getState().toggleFavorite("codex::gpt-6.1-sol");
    tabB.getState().toggleFavorite("omp::gpt-6.1-sol");

    expect(loadModelFavorites(storage)).toEqual(["codex::gpt-6.1-sol", "omp::gpt-6.1-sol"]);

    // 写入完成后再分别向对方投递 storage 事件。
    expect(
      applyModelFavoritesStorageEvent({ key: favoriteStorageKey("omp::gpt-6.1-sol") }, tabA, storage),
    ).toBe(true);
    expect(
      applyModelFavoritesStorageEvent({ key: favoriteStorageKey("codex::gpt-6.1-sol") }, tabB, storage),
    ).toBe(true);

    expect(tabA.getState().favorites).toEqual(["codex::gpt-6.1-sol", "omp::gpt-6.1-sol"]);
    expect(tabB.getState().favorites).toEqual(["codex::gpt-6.1-sol", "omp::gpt-6.1-sol"]);

    const refreshed = createModelFavoritesStore(storage);
    expect(refreshed.getState().favorites).toEqual(["codex::gpt-6.1-sol", "omp::gpt-6.1-sol"]);
  });

  test("一页新增、另一页删除不同键时互不干扰，事件后收敛", () => {
    const storage = memoryStorage({ [favoriteStorageKey("omp::claude-x")]: "1" });
    const tabA = createModelFavoritesStore(storage);
    const tabB = createModelFavoritesStore(storage);

    tabA.getState().toggleFavorite("codex::gpt-6.1-sol");
    tabB.getState().toggleFavorite("omp::claude-x");
    expect(loadModelFavorites(storage)).toEqual(["codex::gpt-6.1-sol"]);

    applyModelFavoritesStorageEvent({ key: favoriteStorageKey("omp::claude-x") }, tabA, storage);
    applyModelFavoritesStorageEvent({ key: favoriteStorageKey("codex::gpt-6.1-sol") }, tabB, storage);
    expect(tabA.getState().favorites).toEqual(["codex::gpt-6.1-sol"]);
    expect(tabB.getState().favorites).toEqual(["codex::gpt-6.1-sol"]);
  });

  test("storage 事件忽略无关键与缺失键，clear 后重读为空", () => {
    const storage = memoryStorage({ [favoriteStorageKey("codex::gpt-6.1-sol")]: "1" });
    const store = createModelFavoritesStore(storage);
    expect(store.getState().favorites).toEqual(["codex::gpt-6.1-sol"]);

    expect(applyModelFavoritesStorageEvent({ key: "wb-theme" }, store, storage)).toBe(false);
    expect(applyModelFavoritesStorageEvent({}, store, storage)).toBe(false);
    expect(store.getState().favorites).toEqual(["codex::gpt-6.1-sol"]);

    storage.removeItem(favoriteStorageKey("codex::gpt-6.1-sol"));
    expect(applyModelFavoritesStorageEvent({ key: null }, store, storage)).toBe(true);
    expect(store.getState().favorites).toEqual([]);
  });
});

describe("模型选项分组与搜索", () => {
  test("工作台只列出已安装 Harness，收藏分组保留原有顺序且不重复", () => {
    const options = collectModelOptions(HARNESSES);
    expect(options.map((option) => option.key)).toEqual([
      "codex::gpt-6.1-sol",
      "codex::gpt-6.1-mini",
      "omp::gpt-6.1-sol",
      "omp::claude-x",
    ]);

    const sections = splitFavoriteRunnerModelOptions(options, [
      "omp::gpt-6.1-sol",
      "codex::gpt-6.1-sol",
      "opencode::not-in-list",
    ]);
    expect(sections.favorites.map((option) => option.key)).toEqual([
      "codex::gpt-6.1-sol",
      "omp::gpt-6.1-sol",
    ]);
    expect(sections.groups.map((group) => group.label)).toEqual(["Codex", "Oh My Pi"]);
    expect(sections.groups[0]!.items.map((option) => option.key)).toEqual(["codex::gpt-6.1-mini"]);
    expect(sections.groups[1]!.items.map((option) => option.key)).toEqual(["omp::claude-x"]);

    // 暂不在此入口列表中的收藏保持隐藏；列表重新可用后恢复显示。
    const routingSections = splitFavoriteRunnerModelOptions(collectRoutingModelOptions(HARNESSES), [
      "opencode::opencode/free",
    ]);
    expect(routingSections.favorites.map((option) => option.key)).toEqual(["opencode::opencode/free"]);
  });

  test("无收藏时不产生收藏分组，取消收藏后回到原 Harness 分组", () => {
    const options = collectModelOptions(HARNESSES);
    const none = splitFavoriteRunnerModelOptions(options, []);
    expect(none.favorites).toEqual([]);
    expect(none.groups.flatMap((group) => group.items.map((option) => option.key))).toEqual(
      options.map((option) => option.key),
    );

    const restored = splitFavoriteRunnerModelOptions(options, ["codex::gpt-6.1-mini"]);
    expect(restored.favorites.map((option) => option.key)).toEqual(["codex::gpt-6.1-mini"]);
    expect(restored.groups[0]!.items.map((option) => option.key)).toEqual(["codex::gpt-6.1-sol"]);
  });

  test("配置弹窗选项包含未安装 Harness、未验证标记并保留列表外当前配置", () => {
    const options = collectRoutingModelOptions(HARNESSES, "codex::retired-model");
    const keys = options.map((option) => option.key);
    expect(keys).toContain("opencode::opencode/free");
    expect(keys).toContain("codex::retired-model");
    expect(keys.filter((key) => key === "codex::retired-model")).toHaveLength(1);
    expect(options.find((option) => option.key === "opencode::opencode/free")?.unverified).toBe(true);
    expect(options.find((option) => option.key === "codex::retired-model")?.preserved).toBe(true);
    expect(options.find((option) => option.key === "opencode::opencode/free")?.harnessLabel).toContain("未安装");

    const inList = collectRoutingModelOptions(HARNESSES, "codex::gpt-6.1-sol");
    expect(inList.some((option) => option.preserved)).toBe(false);
  });

  test("搜索覆盖 Harness、模型、显示名、Provider 及标记，空状态可判定", () => {
    const options = collectRoutingModelOptions(HARNESSES, "codex::retired-model");
    expect(filterRunnerModelOptions(options, "").length).toBe(options.length);
    expect(filterRunnerModelOptions(options, "openai").map((option) => option.key)).toEqual([
      "codex::gpt-6.1-sol",
    ]);
    expect(filterRunnerModelOptions(options, "Sol via OMP").map((option) => option.key)).toEqual([
      "omp::gpt-6.1-sol",
    ]);
    expect(filterRunnerModelOptions(options, "opencode").map((option) => option.key)).toEqual([
      "opencode::opencode/free",
    ]);
    expect(filterRunnerModelOptions(options, "未验证").map((option) => option.key)).toEqual([
      "opencode::opencode/free",
    ]);
    expect(filterRunnerModelOptions(options, "保留").map((option) => option.key)).toEqual([
      "codex::retired-model",
    ]);
    expect(filterRunnerModelOptions(options, "不存在的模型")).toEqual([]);
  });
});

describe("收藏选择菜单静态结构", () => {
  test("收藏分组位于普通分组之前，收藏项不重复且带中文无障碍状态", () => {
    const html = renderToStaticMarkup(
      <ModelPickerMenu
        options={collectModelOptions(HARNESSES)}
        selectedKey="omp::claude-x"
        onSelect={() => undefined}
        favorites={["codex::gpt-6.1-sol"]}
        testIdPrefix="picker"
      />,
    );

    const favoritesGroupIndex = html.indexOf('data-testid="picker-favorites"');
    const codexGroupIndex = html.indexOf('data-testid="picker-group-codex"');
    expect(favoritesGroupIndex).toBeGreaterThan(-1);
    expect(codexGroupIndex).toBeGreaterThan(favoritesGroupIndex);
    expect(html.split('data-testid="picker-option-codex::gpt-6.1-sol"')).toHaveLength(2);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("取消收藏 Codex · gpt-6.1-sol");
    expect(html).toContain("收藏 Codex · gpt-6.1-mini");
    expect(html).toContain("Codex · GPT-6.1 Sol");
    expect(html).toContain("Sol via OMP");
  });

  test("无收藏时隐藏收藏分组，快捷策略仍渲染在首位", () => {
    const html = renderToStaticMarkup(
      <ModelPickerMenu
        options={collectModelOptions(HARNESSES)}
        selectedKey=""
        onSelect={() => undefined}
        shortcuts={[
          {
            key: "default",
            value: "__auto__ 默认路由 自动路由",
            content: "自动路由",
            selected: true,
            onSelect: () => undefined,
          },
        ]}
        testIdPrefix="picker"
      />,
    );
    expect(html).not.toContain('data-testid="picker-favorites"');
    expect(html).not.toContain('data-testid="picker-fav-__auto__"');
    expect(html.indexOf('data-testid="picker-shortcuts"')).toBeLessThan(
      html.indexOf('data-testid="picker-group-codex"'),
    );
  });

  test("配置弹窗菜单显示未安装、未验证、保留项与搜索框", () => {
    const html = renderToStaticMarkup(
      <ModelPickerMenu
        options={collectRoutingModelOptions(HARNESSES, "codex::retired-model")}
        selectedKey="codex::retired-model"
        onSelect={() => undefined}
        testIdPrefix="route"
      />,
    );
    expect(html).toContain("未安装");
    expect(html).toContain("未验证");
    expect(html).toContain("保留");
    expect(html).toContain('data-testid="route-search"');
  });

  test("配置弹窗原生 select 同步保留当前配置值与未验证选项", () => {
    const html = renderToStaticMarkup(
      <RoutingModelPicker
        testId="route-select-design"
        harnesses={HARNESSES}
        value="codex::retired-model"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="route-select-design"');
    expect(html).toContain('data-field="route-model-select"');
    expect(html).toContain('value="codex::retired-model"');
    expect(html).toContain("codex · retired-model · 保留");
    expect(html).toContain("opencode · opencode/free · 未验证");
    expect(html).toContain('data-testid="route-select-design-trigger"');

    const enHarnesses = [
      ...HARNESSES.slice(0, 2),
      harness("opencode", "OpenCode", false, [model("opencode/free", { label: "Free model", source: "builtin" })]),
    ];
    const menuEn = renderToStaticMarkup(
      <ModelPickerMenu
        options={collectRoutingModelOptions(enHarnesses, "codex::retired-model", "en")}
        selectedKey="codex::retired-model"
        favorites={["codex::gpt-6.1-sol"]}
        onSelect={() => undefined}
        testIdPrefix="route-en"
        language="en"
      />,
    );
    expect(menuEn).toContain("Favorites");
    expect(menuEn).toContain("Not installed");
    expect(menuEn).toContain("unverified");
    expect(menuEn).toContain("Preserved");
    expect(menuEn).toContain("Unfavorite");
    expect(/[\u4e00-\u9fff]/.test(menuEn)).toBe(false);

    const pickerEn = renderToStaticMarkup(
      <RoutingModelPicker
        testId="route-select-design-en"
        harnesses={enHarnesses}
        value="codex::retired-model"
        onChange={() => undefined}
        language="en"
      />,
    );
    expect(pickerEn).toContain("codex · retired-model · Preserved");
    expect(pickerEn).toContain("opencode · opencode/free · unverified");
    expect(/[\u4e00-\u9fff]/.test(pickerEn)).toBe(false);
  });
});