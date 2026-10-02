/**
 * TUI side of the modes spec (Phase 1): the Shift+Tab decision, the `/permission` menu and
 * transitions, the `/reload` guard, the changelog panel and the per-viewer `lastSeenVersion`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_AGENTS, FULL_ACCESS_WARNING } from "@alisio/core";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownPanel } from "../packages/cli/src/tui/components.ts";
import {
  agentCycleHint,
  CYCLE_BLOCKED_HINT,
  modeDisplay,
  permissionMenuRows,
  permissionTransition,
  RELOAD_BUSY,
  reloadGuard,
  shiftTabDecision,
} from "../packages/cli/src/tui/modes.ts";
import { identityParts, resolveCommand } from "../packages/cli/src/tui/state.ts";
import {
  readViewerState,
  viewerStateFile,
  writeViewerState,
} from "../packages/cli/src/tui/viewer-state.ts";

const SHIFT_TAB = "\x1b[Z";
const idle = { busy: false, picker: false, autocomplete: false, panelFocused: false };
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("Shift+Tab decision", () => {
  it("cycles when the editor owns the keyboard and no turn runs", () => {
    expect(shiftTabDecision(SHIFT_TAB, idle)).toEqual({ type: "cycle" });
  });

  it("recognises the Kitty keyboard encoding of Shift+Tab too", () => {
    expect(shiftTabDecision("\x1b[9;2u", idle)).toEqual({ type: "cycle" });
  });

  it("ignores every other key, including a plain Tab", () => {
    for (const data of ["\t", "a", "\x1b", "\r", "\x1b[A"])
      expect(shiftTabDecision(data, idle)).toEqual({ type: "ignore" });
  });

  it("is blocked with a hint during a turn, and the key is consumed by the caller", () => {
    expect(shiftTabDecision(SHIFT_TAB, { ...idle, busy: true })).toEqual({
      type: "blocked",
      hint: CYCLE_BLOCKED_HINT,
    });
    expect(CYCLE_BLOCKED_HINT).toContain("wait for it to finish");
  });

  it("leaves the key alone while a picker, the autocomplete list or the agents panel is open", () => {
    for (const override of [{ picker: true }, { autocomplete: true }, { panelFocused: true }])
      expect(shiftTabDecision(SHIFT_TAB, { ...idle, ...override })).toEqual({ type: "ignore" });
    // The picker wins over a running turn: nothing is consumed or announced.
    expect(shiftTabDecision(SHIFT_TAB, { ...idle, busy: true, picker: true })).toEqual({
      type: "ignore",
    });
  });

  it("names the agent and warns when it declares another model", () => {
    const plan = BUILTIN_AGENTS.find((a) => a.id === "plan");
    if (!plan) throw new Error("plan agent missing");
    expect(agentCycleHint(plan, "m")).toBe("Agent: plan (read-only) · Shift+Tab cycles agents");
    expect(agentCycleHint({ ...plan, model: "other/model" }, "m")).toContain(
      "declares model other/model: run /agents to apply it",
    );
    expect(agentCycleHint({ ...plan, model: "m" }, "m")).not.toContain("declares");
  });
});

describe("/permission menu and transitions", () => {
  it("lists exactly the five entries in order and marks the current mode", () => {
    const rows = permissionMenuRows("auto");
    expect(rows.map((r) => r.label)).toEqual([
      "Use ask mode",
      "Use auto mode (current)",
      "Use full access mode",
      "Status",
      "Manage saved permissions…",
    ]);
    expect(rows.map((r) => r.value)).toEqual(["ask", "auto", "full", "status", "manage"]);
    expect(rows[2]?.description).toContain("Not a sandbox");
  });

  it("is resolved from /permissions as well (alias of the same menu)", () => {
    expect(resolveCommand("permission")).toBe("permission");
    expect(resolveCommand("permissions")).toBe("permission");
    expect(resolveCommand("reload")).toBe("reload");
    expect(resolveCommand("changelog")).toBe("changelog");
  });

  it("moves between modes, and warns that full access is not a sandbox", () => {
    expect(permissionTransition("ask", "auto")).toMatchObject({
      ok: true,
      mode: "auto",
      changed: true,
    });
    const full = permissionTransition("auto", "full");
    expect(full).toMatchObject({ ok: true, mode: "full", warning: FULL_ACCESS_WARNING });
    expect(permissionTransition("full", "ask")).not.toHaveProperty("warning");
    // Re-selecting the active mode still succeeds (it resets session approvals).
    expect(permissionTransition("auto", "auto")).toMatchObject({ ok: true, changed: false });
    expect(permissionTransition("custom", "ask")).toMatchObject({ ok: true, changed: true });
  });

  it("is locked under --read-only: no mode can be selected, with an explanation", () => {
    for (const mode of ["ask", "auto", "full"] as const)
      expect(permissionTransition("locked", mode)).toEqual({
        ok: false,
        message: "Permission modes are locked: Alisio was started with --read-only.",
      });
    expect(permissionMenuRows("locked")[0]?.description).toContain("--read-only");
    expect(modeDisplay("locked")).toBe("read-only");
    expect(modeDisplay("auto")).toBe("auto");
  });

  it("puts the mode between the agent and the model in the status row", () => {
    const parts = identityParts({ agent: "plan", mode: "ask", model: "m", provider: "p" });
    expect(parts.map((p) => p.role)).toEqual(["agent", "mode", "model", "provider"]);
    expect(parts[1]?.text).toBe("mode: ask");
  });
});

describe("/reload guard", () => {
  it("only reloads between turns", () => {
    expect(reloadGuard({ busy: true, runningChildren: 0, queuedPrompts: false })).toBe(RELOAD_BUSY);
    expect(reloadGuard({ busy: false, runningChildren: 0, queuedPrompts: false })).toBeUndefined();
  });

  it("also refuses with running subagents or a waiting approval", () => {
    expect(reloadGuard({ busy: false, runningChildren: 2, queuedPrompts: false })).toContain(
      "2 subagents are running",
    );
    expect(reloadGuard({ busy: false, runningChildren: 1, queuedPrompts: false })).toContain(
      "1 subagent is running",
    );
    expect(reloadGuard({ busy: false, runningChildren: 0, queuedPrompts: true })).toContain(
      "approval or question",
    );
  });
});

describe("changelog panel", () => {
  const body = Array.from({ length: 40 }, (_, i) => `- line ${i + 1}`).join("\n");

  it("shows a window of the text and scrolls with the arrows, pages and Home/End", () => {
    let closed = 0;
    const panel = new MarkdownPanel(
      "What's new",
      body,
      () => closed++,
      () => 5,
    );
    const first = panel.render(60).map(strip);
    expect(first.some((l) => l.includes("What's new"))).toBe(true);
    expect(first.some((l) => l.includes("line 1"))).toBe(true);
    expect(first.some((l) => l.includes("line 30"))).toBe(false);
    expect(first.some((l) => l.includes("↓ more"))).toBe(true);
    panel.handleInput("\x1b[B");
    expect(
      panel
        .render(60)
        .map(strip)
        .some((l) => l.includes("↑ more")),
    ).toBe(true);
    panel.handleInput("\x1b[6~"); // PgDn
    panel.handleInput("\x1b[F"); // End
    const end = panel.render(60).map(strip);
    expect(end.some((l) => l.includes("line 40"))).toBe(true);
    expect(end.some((l) => l.includes("↓ more"))).toBe(false);
    panel.handleInput("\x1b[H"); // Home
    expect(
      panel
        .render(60)
        .map(strip)
        .some((l) => l.includes("line 1")),
    ).toBe(true);
    panel.handleInput("\x1b");
    expect(closed).toBe(1);
  });
});

describe("lastSeenVersion (viewer state)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const dir = async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-viewer-"));
    roots.push(root);
    return root;
  };

  it("is empty without a file, and round-trips what was stored", async () => {
    const state = await dir();
    expect(await readViewerState(state)).toEqual({});
    expect(await writeViewerState(state, { lastSeenVersion: "0.1.0-alpha.28" })).toBe(true);
    expect(await readViewerState(state)).toEqual({ lastSeenVersion: "0.1.0-alpha.28" });
    expect(JSON.parse(await readFile(viewerStateFile(state), "utf8"))).toEqual({
      lastSeenVersion: "0.1.0-alpha.28",
    });
  });

  it("survives a corrupt or hostile file", async () => {
    const state = await dir();
    await writeFile(viewerStateFile(state), "{ nope");
    expect(await readViewerState(state)).toEqual({});
    await writeFile(viewerStateFile(state), JSON.stringify({ lastSeenVersion: 7 }));
    expect(await readViewerState(state)).toEqual({});
    await writeFile(viewerStateFile(state), "[]");
    expect(await readViewerState(state)).toEqual({});
    expect(await writeViewerState(state, { lastSeenVersion: "0.1.0" })).toBe(true);
  });

  it("never throws when the state folder cannot be written", async () => {
    const state = await dir();
    const blocker = join(state, "file");
    await writeFile(blocker, "x");
    expect(await writeViewerState(join(blocker, "nested"), { lastSeenVersion: "1.0.0" })).toBe(
      false,
    );
  });
});
