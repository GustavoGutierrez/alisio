/**
 * Project settings dialog: the pure model (name validation and patch, menu items, toggles), the
 * API calls it makes, how the sidebar shows the display name and the EN/ES strings.
 */
import type { SessionSummary, WorkspaceInfo } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  folderName,
  LABEL_MAX,
  labelPatch,
  labelProblem,
  projectMenuItems,
  projectSettingsFacts,
} from "../packages/web/src/components/sidebar/project-settings.ts";
import { projectStrings, ps } from "../packages/web/src/components/sidebar/project-strings.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { locale } from "../packages/web/src/i18n/index.ts";
import { ApiClient } from "../packages/web/src/net/api.ts";
import {
  emptySidebar,
  groupSessions,
  loadSidebar,
  upsertWorkspace,
} from "../packages/web/src/store/sessions.ts";

const ws = (extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id: "w1",
  path: "/home/ana/clases/matematicas",
  pinned: false,
  open: false,
  exists: true,
  trusted: true,
  untrustedResources: false,
  archived: false,
  ...extra,
});
const session = (): SessionSummary => ({
  id: "s1",
  workspaceId: "w1",
  workspace: "/home/ana/clases/matematicas",
  provider: "p",
  model: "m",
  status: "idle",
  pinned: false,
  archived: false,
});

describe("project settings: name", () => {
  it("derives the folder name from the path, for / and \\ separators", () => {
    expect(folderName("/home/ana/clases/matematicas")).toBe("matematicas");
    expect(folderName("C:\\Users\\ana\\Notas\\")).toBe("Notas");
  });

  it("rejects names over the server limit and accepts the limit itself", () => {
    expect(labelProblem("x".repeat(LABEL_MAX))).toBeUndefined();
    expect(labelProblem("x".repeat(LABEL_MAX + 1))).toBe("tooLong");
    expect(labelProblem("   ")).toBeUndefined();
  });

  it("sends the trimmed name, null for a blank one and nothing when unchanged", () => {
    expect(labelPatch("  Math 101  ", ws())).toEqual({ label: "Math 101" });
    expect(labelPatch("   ", ws({ label: "Math 101" }))).toEqual({ label: null });
    expect(labelPatch("Math 101", ws({ label: "Math 101" }))).toBeUndefined();
    expect(labelPatch("", ws())).toBeUndefined();
    expect(labelPatch("x".repeat(LABEL_MAX + 1), ws())).toBeUndefined();
  });

  it("renaming PATCHes label, and the sidebar shows it while the path stays", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const api = new ApiClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(ws({ label: "Math 101" })), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const patch = labelPatch("Math 101", ws());
    expect(patch).toBeDefined();
    const info = await api.patchWorkspace("w1", patch ?? {});
    expect(calls[0]?.url).toBe("/api/workspaces/w1");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ label: "Math 101" });

    const before = loadSidebar(emptySidebar(), [ws()], [session()]);
    expect(groupSessions(before, "")[0]?.name).toBe("matematicas");
    const after = groupSessions(upsertWorkspace(before, info), "")[0];
    expect(after?.name).toBe("Math 101");
    expect(after?.workspace.path).toBe("/home/ana/clases/matematicas");
    expect(projectSettingsFacts(info).folder).toBe("matematicas");
  });

  it("clearing the name restores the folder name", () => {
    const labelled = loadSidebar(emptySidebar(), [ws({ label: "Math 101" })], []);
    expect(groupSessions(labelled, "")[0]?.name).toBe("Math 101");
    const { label: _drop, ...cleared } = ws({ label: "Math 101" });
    expect(groupSessions(upsertWorkspace(labelled, cleared), "")[0]?.name).toBe("matematicas");
  });
});

describe("project settings: menu and toggles", () => {
  it("adds Project settings to the project menu, keeping Color for quick access", () => {
    const ids = projectMenuItems(ws(), (key) => key).map((i) => i.id);
    expect(ids).toEqual(["pin", "color", "settings", "archive", "trust"]);
  });

  it("hides trust for a missing folder", () => {
    const ids = projectMenuItems(ws({ exists: false }), (key) => key).map((i) => i.id);
    expect(ids).not.toContain("trust");
  });

  it("reports the state the dialog shows and the patches the toggles send", () => {
    const facts = projectSettingsFacts(ws({ pinned: true, archived: true, exists: false }));
    expect(facts).toMatchObject({
      folder: "matematicas",
      path: "/home/ana/clases/matematicas",
      missing: true,
      pinPatch: { pinned: false },
      archivePatch: { archived: false },
    });
    expect(projectSettingsFacts(ws()).pinPatch).toEqual({ pinned: true });
    expect(projectSettingsFacts(ws()).archivePatch).toEqual({ archived: true });
  });
});

describe("project settings: strings", () => {
  it("has the same keys in EN and ES and the menu item in both dictionaries", () => {
    expect(Object.keys(projectStrings.es).sort()).toEqual(Object.keys(projectStrings.en).sort());
    expect(en["workspace.settings"]).toBe("Project settings…");
    expect(es["workspace.settings"]).toBe("Ajustes del proyecto…");
    for (const key of Object.keys(projectStrings.en) as Array<keyof typeof projectStrings.en>) {
      const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
      expect(placeholders(projectStrings.es[key])).toEqual(placeholders(projectStrings.en[key]));
    }
    locale.value = "en";
    expect(ps("title")).toBe("Project settings");
    locale.value = "es";
    expect(ps("title")).toBe("Ajustes del proyecto");
    locale.value = "en";
  });
});
