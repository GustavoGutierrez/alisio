import { afterEach, describe, expect, it } from "vitest";
import {
  APPS_VISIBLE,
  appsExpanded,
  capApps,
  setAppsExpanded,
} from "../packages/web/src/store/apps-list.ts";

const apps = (count: number, active = -1) =>
  Array.from({ length: count }, (_, i) => ({ key: `app-${i}`, active: i === active }));

describe("sidebar Apps list cap", () => {
  it("shows every app and no toggle when the list is short", () => {
    const view = capApps(apps(3), false);
    expect(view.shown.map((a) => a.key)).toEqual(["app-0", "app-1", "app-2"]);
    expect(view).toMatchObject({ hidden: 0, toggle: false });
  });

  it("never hides a single app behind a toggle (cap + 1 still shows all)", () => {
    const view = capApps(apps(APPS_VISIBLE + 1), false);
    expect(view.shown).toHaveLength(APPS_VISIBLE + 1);
    expect(view).toMatchObject({ hidden: 0, toggle: false });
  });

  it("caps a long list and reports how many apps are hidden", () => {
    const view = capApps(apps(42), false);
    expect(view.shown.map((a) => a.key)).toEqual(apps(APPS_VISIBLE).map((a) => a.key));
    expect(view).toMatchObject({ hidden: 42 - APPS_VISIBLE, toggle: true });
  });

  it("keeps the open app visible when it falls beyond the cap", () => {
    const view = capApps(apps(42, 30), false);
    expect(view.shown).toHaveLength(APPS_VISIBLE + 1);
    expect(view.shown.at(-1)?.key).toBe("app-30");
    expect(view.hidden).toBe(42 - APPS_VISIBLE - 1);
  });

  it("shows every app when expanded and keeps the toggle to collapse again", () => {
    const view = capApps(apps(42), true);
    expect(view.shown).toHaveLength(42);
    expect(view).toMatchObject({ hidden: 0, toggle: true });
  });
});

describe("sidebar Apps list preference", () => {
  afterEach(() => setAppsExpanded(false));

  it("toggles the expanded state and survives missing storage", () => {
    expect(appsExpanded.value).toBe(false);
    setAppsExpanded(true);
    expect(appsExpanded.value).toBe(true);
    setAppsExpanded(false);
    expect(appsExpanded.value).toBe(false);
  });
});
