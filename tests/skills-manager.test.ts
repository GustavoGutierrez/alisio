import { describe, expect, it } from "vitest";
import {
  cycleSkillSort,
  initialSkillManagerState,
  moveSkillSelection,
  retainSkillSelection,
  type SkillCatalogView,
  SkillsManager,
  skillViewport,
  visibleSkills,
} from "../packages/cli/src/tui/skills-manager.ts";

const entries = (count = 100): SkillCatalogView[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `skill-${String(index).padStart(3, "0")}`,
    effectiveId: `skill-${String(index).padStart(3, "0")}`,
    displayId: `skill-${String(index).padStart(3, "0")}`,
    name: `skill-${index}`,
    description: index % 2 ? "Testing workflow" : "Documentation workflow",
    scope: index % 3 ? "user" : "project",
    source: index % 3 ? "user" : "project",
    manageable: true,
    locked: false,
    enabled: index % 4 !== 0,
    effective: true,
    approximateTokens: 100 + index,
  }));

describe("skills manager state", () => {
  it("bounds a 98+ catalog and reports exact clipping counts", () => {
    const list = entries(100);
    let state = initialSkillManagerState(list);
    state = moveSkillSelection(list, state, "pageDown", 8);
    const viewport = skillViewport(list, state, 8);
    expect(viewport.items).toHaveLength(8);
    expect(viewport.above).toBe(0);
    expect(viewport.below).toBe(92);
    state = moveSkillSelection(list, state, "end", 8);
    const end = skillViewport(list, state, 8);
    expect(end.items).toHaveLength(8);
    expect(end.above).toBe(92);
    expect(end.below).toBe(0);
  });

  it("filters metadata, cycles useful sorts and retains selection", () => {
    const list = entries(12);
    let state = { ...initialSkillManagerState(list), selectedId: "skill-005", query: "testing" };
    expect(visibleSkills(list, state).every((entry) => entry.description.includes("Testing"))).toBe(
      true,
    );
    expect(retainSkillSelection(list, state).selectedId).toBe("skill-005");
    state = { ...state, query: "documentation" };
    expect(retainSkillSelection(list, state).selectedId).toBe("skill-000");
    expect(cycleSkillSort("name")).toBe("source");
    expect(cycleSkillSort("source")).toBe("tokens");
    expect(cycleSkillSort("tokens")).toBe("name");
    expect(visibleSkills(list, { ...state, query: "", sort: "tokens" })[0]?.approximateTokens).toBe(
      111,
    );
  });

  it("keeps selection visible across short and resized viewports", () => {
    const list = entries(20);
    const state = { ...initialSkillManagerState(list), selectedId: "skill-010", offset: 0 };
    const short = skillViewport(list, state, 1);
    expect(short.items.map((entry) => entry.id)).toEqual(["skill-010"]);
    expect(short.above).toBe(10);
    const taller = skillViewport(list, { ...state, offset: short.offset }, 6);
    expect(taller.items.some((entry) => entry.id === "skill-010")).toBe(true);
    expect(taller.items.length).toBeLessThanOrEqual(6);
  });

  it("renders bounded clipping indicators in narrow and short terminals", () => {
    let height = 15;
    const manager = new SkillsManager({
      entries: entries(100),
      height: () => height,
      onClose: () => {},
      onToggle: async () => entries(1)[0]!,
      onError: () => {},
      onChanged: () => {},
      requestRender: () => {},
    });
    const first = manager.render(28);
    expect(first.length).toBeLessThanOrEqual(height);
    expect(first.join("\n")).toContain("↓ 97 more below");
    manager.handleInput("\x1b[F");
    const end = manager.render(28);
    expect(end.join("\n")).toContain("↑ 97 more above");
    height = 8;
    const short = manager.render(12);
    expect(short.length).toBeLessThanOrEqual(8);
    expect(short.every((line) => line.length < 80)).toBe(true);
  });
});
