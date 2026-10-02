/**
 * Web side of the modes spec (Phase 1): the Shift+Tab shortcut decision, the agent cycle, the
 * `/permission`, `/changelog` and `/reload` slash handling, the permission-mode view of the
 * session presets and the discreet "updated" toast (`lastSeenVersion`).
 */
import type {
  AgentInfo,
  ChangelogView,
  CommandDescriptor,
  PermissionPresetInfo,
  SessionDetail,
} from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import {
  agentList,
  api,
  changelogRequest,
  checkChangelogNews,
  commands,
  currentId,
  cycleAgent,
  detail,
  permissionsOpen,
  submit,
  toast,
} from "../packages/web/src/store/app.ts";
import { LAST_SEEN_KEY, newsAction } from "../packages/web/src/store/changelog.ts";
import {
  activeAgentId,
  needsFullAccessConfirm,
  nextAgentId,
  shiftTabCycles,
} from "../packages/web/src/store/modes.ts";
import { modeChoices, modeOfPreset } from "../packages/web/src/store/permission-modes.ts";

const key = (extra: Partial<Parameters<typeof shiftTabCycles>[0]> = {}) => ({
  key: "Tab",
  shiftKey: true,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...extra,
});
const idle = { paletteOpen: false, composing: false, disabled: false };

describe("Shift+Tab in the composer", () => {
  it("cycles on exactly Shift+Tab", () => {
    expect(shiftTabCycles(key(), idle)).toBe(true);
  });

  it("keeps the browser behavior for a plain Tab and any other modifier", () => {
    expect(shiftTabCycles(key({ shiftKey: false }), idle)).toBe(false);
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const)
      expect(shiftTabCycles(key({ [modifier]: true }), idle)).toBe(false);
    expect(shiftTabCycles(key({ key: "Enter" }), idle)).toBe(false);
  });

  it("ignores IME composition, an open slash palette and a disabled composer", () => {
    expect(shiftTabCycles(key({ isComposing: true }), idle)).toBe(false);
    expect(shiftTabCycles(key(), { ...idle, composing: true })).toBe(false);
    expect(shiftTabCycles(key(), { ...idle, paletteOpen: true })).toBe(false);
    expect(shiftTabCycles(key(), { ...idle, disabled: true })).toBe(false);
  });
});

describe("agent cycle over the server's list", () => {
  const agents = [{ id: "build" }, { id: "plan" }, { id: "alpha" }];

  it("steps forward and backward and wraps around", () => {
    expect(nextAgentId(agents, "build")).toBe("plan");
    expect(nextAgentId(agents, "plan")).toBe("alpha");
    expect(nextAgentId(agents, "alpha")).toBe("build");
    expect(nextAgentId(agents, "build", -1)).toBe("alpha");
  });

  it("starts at the first agent for an unknown id and has nothing to cycle when empty", () => {
    expect(nextAgentId(agents, "ghost")).toBe("build");
    expect(nextAgentId(agents, undefined)).toBe("build");
    expect(nextAgentId([], "build")).toBeUndefined();
    expect(nextAgentId([{ id: "only" }], "only")).toBe("only");
  });

  it("uses the session's agent, else the workspace default, else build", () => {
    expect(activeAgentId("plan", [{ id: "build", default: true }])).toBe("plan");
    expect(activeAgentId(undefined, [{ id: "alpha", default: true }, { id: "build" }])).toBe(
      "alpha",
    );
    expect(activeAgentId(undefined, [])).toBe("build");
  });
});

const agentInfo = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  description: `${id} agent`,
  source: "builtin",
  default: id === "build",
  ...extra,
});
const session = (extra: Partial<SessionDetail> = {}): SessionDetail =>
  ({
    id: "s1",
    workspaceId: "w1",
    workspace: "/w",
    provider: "p",
    model: "m",
    status: "idle",
    pinned: false,
    archived: false,
    preset: "workspace-write",
    presets: [],
    children: [],
    ...extra,
  }) as SessionDetail;
const descriptor = (name: string, extra: Partial<CommandDescriptor> = {}): CommandDescriptor => ({
  name,
  description: name,
  source: "builtin",
  surfaces: ["tui", "web"],
  execution: "surface",
  ...extra,
});

describe("web store: agents and slash commands", () => {
  const original = {
    command: api.command,
    session: api.session,
    agents: api.agents,
    changelog: api.changelog,
  };
  let calls: Array<{ name: string; args?: string }>;
  beforeEach(() => {
    calls = [];
    currentId.value = "s1";
    detail.value = session();
    agentList.value = [
      agentInfo("build"),
      agentInfo("plan", { readOnly: true }),
      agentInfo("zeta"),
    ];
    commands.value = [
      descriptor("permission", { aliases: ["permissions"] }),
      descriptor("reload"),
      descriptor("changelog"),
    ];
    permissionsOpen.value = false;
    changelogRequest.value = undefined;
    toast.value = undefined;
    api.command = (async (_id: string, body: { name: string; args?: string }) => {
      calls.push({ name: body.name, ...(body.args ? { args: body.args } : {}) });
      return { output: `ran ${body.name}`, effects: [] };
    }) as typeof api.command;
    api.session = (async () => session()) as typeof api.session;
  });
  afterEach(() => {
    Object.assign(api, original);
    currentId.value = undefined;
    detail.value = undefined;
    agentList.value = [];
  });

  it("Shift+Tab activates the next agent through /agent:<id>", async () => {
    await cycleAgent(1);
    expect(calls).toEqual([{ name: "agent:plan" }]);
    detail.value = session({ agent: "plan" });
    await cycleAgent(1);
    expect(calls.at(-1)).toEqual({ name: "agent:zeta" });
    detail.value = session({ agent: "zeta" });
    await cycleAgent(1);
    expect(calls.at(-1)).toEqual({ name: "agent:build" });
  });

  it("does nothing without a session or with a single agent", async () => {
    agentList.value = [agentInfo("build")];
    await cycleAgent(1);
    detail.value = undefined;
    agentList.value = [agentInfo("build"), agentInfo("plan")];
    await cycleAgent(1);
    expect(calls).toEqual([]);
  });

  it("/permission and /permissions alone open the popover without calling the server", async () => {
    await submit("/permission");
    expect(permissionsOpen.value).toBe(true);
    permissionsOpen.value = false;
    await submit("/permissions");
    expect(permissionsOpen.value).toBe(true);
    expect(calls).toEqual([]);
  });

  it("/permission with a mode or status goes to the command route", async () => {
    await submit("/permission full");
    await submit("/permission status");
    expect(calls).toEqual([
      { name: "permission", args: "full" },
      { name: "permission", args: "status" },
    ]);
    expect(permissionsOpen.value).toBe(false);
  });

  it("/changelog opens the dialog for the asked version and never calls the server", async () => {
    await submit("/changelog alpha.26");
    expect(changelogRequest.value?.version).toBe("alpha.26");
    await submit("/changelog");
    expect(changelogRequest.value?.version).toBe("");
    expect(calls).toEqual([]);
  });

  it("/reload runs through the command route and confirms with a toast", async () => {
    await submit("/reload");
    expect(calls).toEqual([{ name: "reload" }]);
    // The UI language follows the browser: either dictionary is a correct answer.
    expect([en["reloadCmd.done"], es["reloadCmd.done"]]).toContain(toast.value);
  });
});

describe("permission modes in the session presets", () => {
  const preset = (
    id: PermissionPresetInfo["id"],
    mode: PermissionPresetInfo["mode"],
    extra: Partial<PermissionPresetInfo> = {},
  ): PermissionPresetInfo => ({
    id,
    ...(mode ? { mode } : {}),
    available: true,
    policy: { write: false, process: false, external: false },
    approvals: true,
    ...extra,
  });
  const presets = [
    preset("read-only", undefined, { approvals: false }),
    preset("ask", "ask"),
    preset("workspace-write", "auto", {
      reason: "process still asks: started without --allow-process",
    }),
    preset("full-access", "full", {
      available: false,
      reason: "The server was started with --read-only",
    }),
  ];

  it("lists ask, auto and full in order, never read-only, and marks the current one", () => {
    const choices = modeChoices(presets, "workspace-write");
    expect(choices.map((c) => c.mode)).toEqual(["ask", "auto", "full"]);
    expect(choices.map((c) => c.checked)).toEqual([false, true, false]);
    expect(choices[1]?.reason).toContain("process still asks");
    expect(choices[2]).toMatchObject({ available: false, preset: "full-access" });
    expect(modeOfPreset(presets, "workspace-write")).toBe("auto");
    expect(modeOfPreset(presets, "read-only")).toBeUndefined();
  });

  it("is empty for a server that offers no modes and asks for the full-access warning", () => {
    expect(modeChoices([], "ask")).toEqual([]);
    expect(needsFullAccessConfirm("full-access", "ask")).toBe(true);
    expect(needsFullAccessConfirm("full-access", "full-access")).toBe(false);
    expect(needsFullAccessConfirm("workspace-write", "ask")).toBe(false);
  });
});

describe("lastSeenVersion (discreet 'updated' toast)", () => {
  const view = (extra: Partial<ChangelogView> = {}): ChangelogView => ({
    current: "0.1.0-alpha.28",
    entries: [],
    found: true,
    ...extra,
  });

  it("stays silent on a first visit and records the version", () => {
    expect(newsAction(undefined, view())).toEqual({ record: "0.1.0-alpha.28" });
  });

  it("does nothing when the version is unchanged", () => {
    expect(newsAction("0.1.0-alpha.28", view())).toEqual({});
  });

  it("mentions the news once after an upgrade and records the new version", () => {
    expect(
      newsAction(
        "0.1.0-alpha.25",
        view({ news: { latest: "0.1.0-alpha.28", versions: ["0.1.0-alpha.28"] } }),
      ),
    ).toEqual({ toast: "0.1.0-alpha.28", record: "0.1.0-alpha.28" });
  });

  it("records silently on a downgrade and never records a development build", () => {
    expect(newsAction("0.1.0-alpha.30", view())).toEqual({ record: "0.1.0-alpha.28" });
    expect(newsAction("0.1.0-alpha.25", view({ current: "dev" }))).toEqual({});
  });

  describe("with browser storage", () => {
    const store = new Map<string, string>();
    beforeEach(() => {
      store.clear();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      });
      toast.value = undefined;
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shows one toast after an upgrade, then not again", async () => {
      store.set(LAST_SEEN_KEY, "0.1.0-alpha.25");
      const spy = vi
        .spyOn(api, "changelog")
        .mockResolvedValue(
          view({ news: { latest: "0.1.0-alpha.28", versions: ["0.1.0-alpha.28"] } }),
        );
      await checkChangelogNews();
      expect(spy).toHaveBeenCalledWith({ lastSeen: "0.1.0-alpha.25" });
      expect(toast.value).toContain("0.1.0-alpha.28");
      expect(store.get(LAST_SEEN_KEY)).toBe("0.1.0-alpha.28");
      toast.value = undefined;
      spy.mockResolvedValue(view());
      await checkChangelogNews();
      expect(toast.value).toBeUndefined();
      spy.mockRestore();
    });

    it("works with storage that throws (private window): no toast, no crash", async () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      });
      const spy = vi.spyOn(api, "changelog").mockResolvedValue(view());
      await expect(checkChangelogNews()).resolves.toMatchObject({ current: "0.1.0-alpha.28" });
      expect(toast.value).toBeUndefined();
      spy.mockRestore();
    });

    it("never fails the page when the changelog cannot be loaded", async () => {
      const spy = vi.spyOn(api, "changelog").mockRejectedValue(new Error("offline"));
      await expect(checkChangelogNews()).resolves.toBeUndefined();
      spy.mockRestore();
    });
  });
});

describe("strings", () => {
  const keys = [
    "composer.agent",
    "composer.agentHint",
    "mode.auto",
    "modes.title",
    "modes.fullConfirm",
    "modes.manage",
    "changelog.title",
    "changelog.news",
    "reloadCmd.done",
  ] as const;

  it("has English and Spanish text for every new key", () => {
    for (const k of keys) {
      expect(en[k], k).toBeTruthy();
      expect(es[k], k).toBeTruthy();
    }
    expect(es["modes.fullConfirm"]).not.toBe(en["modes.fullConfirm"]);
  });

  it("says full access is not a sandbox in both languages", () => {
    expect(en["modes.fullConfirm"]).toContain("Not a sandbox");
    expect(es["modes.fullConfirm"]).toContain("No es un sandbox");
    expect(en["presetHint.full-access"]).toContain("without asking");
    expect(es["presetHint.full-access"]).toBeTruthy();
  });
});
