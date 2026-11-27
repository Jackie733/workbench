export interface SelectHelperPage {
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(
    fn: string | ((...args: any[]) => boolean),
    opts?: { timeout?: number },
    ...args: unknown[]
  ): Promise<unknown>;
  click(sel: string): Promise<void>;
  select(sel: string, ...values: string[]): Promise<string[]>;
  evaluate<T = any>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
}

/**
 * Selects an option in either a native `<select>` (including `sr-only` selects)
 * or a coss / Base UI `<SimpleSelect>` trigger (`[data-slot="select-trigger"]`).
 */
export async function selectUiOption(
  page: SelectHelperPage,
  selector: string,
  value: string,
): Promise<void> {
  await page.waitForSelector(selector, { timeout: 10_000 });
  const tagName = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    return el ? el.tagName.toUpperCase() : null;
  }, selector);

  if (tagName === "SELECT") {
    await page.select(selector, value);
    return;
  }

  const itemSelector = `[data-slot="select-popup"][data-open] [data-slot="select-item"][data-value=${JSON.stringify(value)}]`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const triggerDirectlyHittable = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(top && (el === top || el.contains(top)));
    }, selector);

    if (triggerDirectlyHittable) {
      await page.click(selector);
    } else {
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`Missing select trigger: ${sel}`);
        el.click();
      }, selector);
    }

    // 并发跑全量浏览器用例时 CPU 争用明显，给弹层渲染留出更充足的稳定窗口。
    await page.waitForSelector(itemSelector, { timeout: 30_000 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    const status = await page.evaluate((sel: string) => {
      const item = document.querySelector(sel) as HTMLElement | null;
      if (!item) return "missing" as const;
      item.scrollIntoView({ block: "nearest" });
      const r = item.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return "hidden" as const;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(top && (item === top || item.contains(top)))
        ? ("hittable" as const)
        : ("covered" as const);
    }, itemSelector);

    if (status === "missing") {
      continue;
    }
    if (status === "hittable") {
      await page.click(itemSelector);
    } else {
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`Missing select item: ${sel}`);
        el.scrollIntoView({ block: "nearest" });
        el.click();
      }, itemSelector);
    }
    break;
  }

  await page.waitForFunction(
    (sel: string) => {
      const trigger = document.querySelector(sel);
      const openPopup = document.querySelector('[data-slot="select-popup"][data-open]');
      return !openPopup && trigger?.getAttribute("aria-expanded") !== "true";
    },
    { timeout: 10_000 },
    selector,
  );
}
