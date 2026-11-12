/** Sidebar "Settings & tools" menu: one data array of entries, each opening its window. */
import { describe, expect, it } from "vitest";
import { openTool, TOOLS } from "../packages/web/src/components/sidebar/tools-menu.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { agentsOpen, settingsOpen, skillBuilderOpen } from "../packages/web/src/store/app.ts";

describe("sidebar tools menu", () => {
  it("lists Agents, Skill builder and Settings in that order", () => {
    expect(TOOLS.map((tool) => tool.id)).toEqual(["agents", "skillBuilder", "settings"]);
  });

  it("opens the matching window and ignores unknown ids", () => {
    openTool("agents");
    expect(agentsOpen.value).toBe(true);
    openTool("skillBuilder");
    expect(skillBuilderOpen.value).toBe(true);
    expect(settingsOpen.value).toBe(false);
    openTool("settings");
    expect(settingsOpen.value).toBe(true);
    expect(() => openTool("nope")).not.toThrow();
  });

  it("has a label and a description in both languages", () => {
    for (const key of ["sidebar.tools", ...TOOLS.flatMap((tool) => [tool.label, tool.hint])]) {
      expect(en[key as keyof typeof en], key).toBeTruthy();
      expect(es[key as keyof typeof es], key).toBeTruthy();
    }
  });
});
