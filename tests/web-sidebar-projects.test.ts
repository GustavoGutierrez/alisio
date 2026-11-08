import type { SessionSummary, WorkspaceInfo } from "@alisio/sdk";
import { WORKSPACE_COLOR_IDS } from "@alisio/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  colorName,
  nextColorIndex,
  PALETTE_IDS,
  paletteOptions,
} from "../packages/web/src/components/sidebar/palette.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import {
  allCollapsed,
  closedFolders,
  folderOpen,
  reloadFolders,
  setFoldersOpen,
} from "../packages/web/src/store/folders.ts";
import {
  emptySidebar,
  groupSessions,
  loadSidebar,
  projectSections,
} from "../packages/web/src/store/sessions.ts";

const ws = (id: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id,
  path: `/p/${id}`,
  pinned: false,
  open: false,
  exists: true,
  trusted: true,
  untrustedResources: false,
  archived: false,
  ...extra,
});
const session = (id: string, workspaceId: string, updatedAt?: number): SessionSummary => ({
  id,
  workspaceId,
  workspace: `/p/${workspaceId}`,
  provider: "p",
  model: "m",
  status: "idle",
  pinned: false,
  archived: false,
  ...(updatedAt === undefined ? {} : { updatedAt }),
});
const ids = (groups: Array<{ workspace: WorkspaceInfo }>) => groups.map((g) => g.workspace.id);

describe("project sections", () => {
  const state = loadSidebar(
    emptySidebar(),
    [
      ws("a", { lastOpenedAt: 5 }),
      ws("b", { pinned: true }),
      ws("c", { pinned: true }),
      ws("d", { lastOpenedAt: 500 }),
      ws("e"),
      ws("f", { archived: true, pinned: true }),
    ],
    [session("s1", "a", 900), session("s2", "e", 300), session("s3", "b", 1)],
  );

  it("orders Recent by latest activity (session update or last opened), newest first", () => {
    const sections = projectSections(groupSessions(state, ""));
    expect(sections.map((s) => s.id)).toEqual(["pinned", "recent"]);
    expect(ids(sections[1]?.groups ?? [])).toEqual(["a", "d", "e"]);
  });

  it("lists Pinned in a stable path order, independent of activity", () => {
    const [pinned] = projectSections(groupSessions(state, ""));
    expect(ids(pinned?.groups ?? [])).toEqual(["b", "c"]);
  });

  it("shows one heading-less list ordered like Recent when nothing is pinned", () => {
    const none = loadSidebar(
      emptySidebar(),
      [ws("a"), ws("b", { lastOpenedAt: 50 }), ws("c")],
      [session("s", "a", 10)],
    );
    const sections = projectSections(groupSessions(none, ""));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe("all");
    expect(ids(sections[0]?.groups ?? [])).toEqual(["b", "a", "c"]);
  });

  it("keeps archived projects last and out of Pinned, and search works inside the groups", () => {
    const withArchived = projectSections(groupSessions(state, "", true));
    expect(ids(withArchived[1]?.groups ?? []).at(-1)).toBe("f");
    expect(ids(withArchived[0]?.groups ?? [])).toEqual(["b", "c"]);
    const found = projectSections(groupSessions(state, "s2"));
    expect(found.flatMap((s) => ids(s.groups))).toEqual(["e"]);
  });
});

describe("remembered collapsed folders", () => {
  const store = new Map<string, string>();
  let writes = 0;
  beforeEach(() => {
    store.clear();
    writes = 0;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes++;
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    };
    reloadFolders();
  });

  it("restores collapsed folders after a reload; new projects default to open", () => {
    setFoldersOpen(["a", "b"], false);
    setFoldersOpen(["b"], true);
    reloadFolders();
    expect(folderOpen("a", closedFolders.value, "")).toBe(false);
    expect(folderOpen("b", closedFolders.value, "")).toBe(true);
    expect(folderOpen("brand-new", closedFolders.value, "")).toBe(true);
  });

  it("an active search forces folders open without touching the saved state", () => {
    setFoldersOpen(["a"], false);
    const before = writes;
    expect(folderOpen("a", closedFolders.value, "parser")).toBe(true);
    expect(writes).toBe(before);
    expect(folderOpen("a", closedFolders.value, "  ")).toBe(false);
    reloadFolders();
    expect(closedFolders.value.has("a")).toBe(true);
  });

  it("remembers collapsed Pinned/Recent subgroups; search opens them without saving", () => {
    setFoldersOpen(["group:pinned"], false);
    reloadFolders();
    expect(folderOpen("group:pinned", closedFolders.value, "")).toBe(false);
    expect(folderOpen("group:recent", closedFolders.value, "")).toBe(true);
    const before = writes;
    expect(folderOpen("group:pinned", closedFolders.value, "x")).toBe(true);
    expect(writes).toBe(before);
  });

  it("expand/collapse all only acts on the listed project folders, not on subgroups", () => {
    setFoldersOpen(["group:pinned"], false);
    setFoldersOpen(["a", "b"], false);
    setFoldersOpen(["a", "b"], true);
    expect(closedFolders.value.has("group:pinned")).toBe(true);
    expect(allCollapsed(["group:pinned"], closedFolders.value)).toBe(true);
  });

  it("expand/collapse all: collapses when any is open, expands when all are collapsed", () => {
    const all = ["a", "b", "c"];
    expect(allCollapsed(all, closedFolders.value)).toBe(false);
    setFoldersOpen(all, false);
    expect(allCollapsed(all, closedFolders.value)).toBe(true);
    setFoldersOpen(all, true);
    expect(closedFolders.value.size).toBe(0);
    expect(store.has("alisio.folders")).toBe(false);
    expect(allCollapsed([], closedFolders.value)).toBe(false);
  });

  it("survives corrupt or unavailable storage", () => {
    store.set("alisio.folders", "{not json");
    reloadFolders();
    expect(closedFolders.value.size).toBe(0);
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(() => setFoldersOpen(["a"], false)).not.toThrow();
    expect(closedFolders.value.has("a")).toBe(true);
  });
});

describe("color palette", () => {
  it("offers exactly the ids the server accepts, after a Default option", () => {
    expect([...PALETTE_IDS]).toEqual([...WORKSPACE_COLOR_IDS]);
    const options = paletteOptions(undefined, "en");
    expect(options.map((o) => o.id)).toEqual([undefined, ...WORKSPACE_COLOR_IDS]);
  });

  it("names every option in English and Spanish and marks only the current one", () => {
    for (const lang of ["en", "es"] as const)
      for (const id of [undefined, ...PALETTE_IDS]) expect(colorName(id, lang)).not.toBe(id);
    expect(colorName("blue", "en")).toBe("Blue");
    expect(colorName("blue", "es")).toBe("Azul");
    const options = paletteOptions("blue", "en");
    expect(options.filter((o) => o.checked).map((o) => o.name)).toEqual(["Blue"]);
    expect(options.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    expect(paletteOptions(undefined, "en")[0]).toMatchObject({ checked: true, tabIndex: 0 });
    // An unknown stored value falls back to Default instead of leaving no tab stop.
    expect(paletteOptions("not-a-color", "en")[0]?.checked).toBe(true);
  });

  it("moves with the arrow keys, wrapping, plus Home and End", () => {
    expect(nextColorIndex("ArrowRight", 10, 11)).toBe(0);
    expect(nextColorIndex("ArrowLeft", 0, 11)).toBe(10);
    expect(nextColorIndex("Home", 4, 11)).toBe(0);
    expect(nextColorIndex("End", 4, 11)).toBe(10);
    expect(nextColorIndex("a", 4, 11)).toBe(-1);
  });
});

describe("Projects wording and new strings", () => {
  const keys = [
    "sidebar.workspaces",
    "sidebar.pinnedGroup",
    "sidebar.recentGroup",
    "sidebar.collapseAll",
    "sidebar.expandAll",
    "workspace.color",
    "sidebar.addWorkspace",
    "browser.title",
  ] as const;

  it("has every key in both locales", () => {
    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
    }
    expect(en["sidebar.workspaces"]).toBe("Projects");
    expect(es["sidebar.workspaces"]).toBe("Proyectos");
    expect(es["sidebar.pinnedGroup"]).toBe("Fijados");
    expect(es["sidebar.recentGroup"]).toBe("Recientes");
  });

  it("no longer says workspace in the sidebar strings", () => {
    const sidebarKeys = (Object.keys(en) as Array<keyof typeof en>).filter(
      (k) =>
        k.startsWith("sidebar.") ||
        k.startsWith("workspace.") ||
        k.startsWith("browser.") ||
        k.startsWith("trust.") ||
        k === "error.workspaceArchived",
    );
    for (const key of sidebarKeys) {
      expect(en[key]).not.toMatch(/workspace/i);
      expect((es as Record<string, string>)[key]).not.toMatch(/workspace|espacio de trabajo/i);
    }
  });
});
