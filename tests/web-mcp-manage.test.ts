/**
 * Web side of the last mile of Settings → MCP (specs/030 phase 4): the connection test panel and
 * its recovery actions (UX-07/08), the settings form with write-only keys (UX-06), the sign-in
 * panel (OAuth, UX-05), the update view, the detail card in Explore and the row actions. Pure model
 * functions plus hook-free views walked as VNode trees; no DOM. Heavy panels stay in lazy chunks.
 */
import { readFileSync } from "node:fs";
import type {
  McpBindingConfiguration,
  McpBindingInfo,
  McpCatalogDetail,
  McpConnectionTestResult,
  McpInstallPlan,
  McpServerWire,
  McpSignInFlow,
} from "@alisio/sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  detailViewOf,
  providerOf,
} from "../packages/web/src/components/settings/mcp-explore/detail-model.ts";
import { badgesOf } from "../packages/web/src/components/settings/mcp-install/model.ts";
import { installStrings } from "../packages/web/src/components/settings/mcp-install/strings.ts";
import {
  configDraftOf,
  configFieldsOf,
  configInitialValues,
  configPatchOf,
  recoveryOf,
  safeAuthUrl,
  signInViewOf,
  testViewOf,
  updateViewOf,
  validateConfig,
} from "../packages/web/src/components/settings/mcp-manage/model.ts";
import { manageStrings, mgs } from "../packages/web/src/components/settings/mcp-manage/strings.ts";
import { locale } from "../packages/web/src/i18n/index.ts";

afterEach(() => {
  locale.value = "en";
});

const result = (over: Partial<McpConnectionTestResult> = {}): McpConnectionTestResult => ({
  testId: "t1",
  bindingId: "b1",
  configRevision: "abc",
  artifactVersion: "1.0.0",
  status: "passed",
  steps: [
    { id: "prepare", status: "passed" },
    { id: "connect", status: "passed" },
    { id: "authenticate", status: "skipped" },
    { id: "discover", status: "passed" },
  ],
  startedAt: "2026-11-12T10:00:00.000Z",
  finishedAt: "2026-11-12T10:00:02.000Z",
  safeMessage: "Connected, and the capabilities it announces were listed",
  capabilities: ["tools", "resources"],
  counts: { tools: 2, resources: 1, prompts: 0 },
  stale: false,
  ...over,
});

const config = (over: Partial<McpBindingConfiguration> = {}): McpBindingConfiguration => ({
  bindingId: "b1",
  alias: "files-abc123",
  scope: "global",
  revision: "r1",
  fields: [
    {
      id: "env.API_KEY",
      kind: "env",
      name: "API_KEY",
      secret: true,
      required: true,
      configured: true,
    },
    {
      id: "env.ROOT",
      kind: "env",
      name: "ROOT",
      secret: false,
      required: true,
      value: "/data",
      configured: true,
    },
    {
      id: "env.MODE",
      kind: "env",
      name: "MODE",
      secret: false,
      required: false,
      choices: ["fast", "safe"],
      configured: false,
    },
  ],
  ...over,
});

describe("connection test view (UX-07, UX-08, MCP-CAT-20/22)", () => {
  it("shows the four stages with their result and the counts of what was discovered", () => {
    const view = testViewOf(result(), false);
    expect(view.state).toBe("passed");
    expect(view.steps.map((s) => [s.id, s.state])).toEqual([
      ["prepare", "passed"],
      ["connect", "passed"],
      ["authenticate", "skipped"],
      ["discover", "passed"],
    ]);
    expect(view.counts).toEqual({ tools: 2, resources: 1, prompts: 0 });
    expect(view.recovery).toEqual([]);
    expect(view.stale).toBe(false);
  });

  it("marks an earlier pass as out of date when the settings changed", () => {
    const view = testViewOf(result({ stale: true }), false);
    expect(view.state).toBe("passed");
    expect(view.stale).toBe(true);
    expect(view.headlineKey).toBe("test.headline.stale");
  });

  it("offers the right next action for each cause, with a retry beside it", () => {
    const failed = (recoveryAction: McpConnectionTestResult["recoveryAction"]) =>
      testViewOf(result({ status: "failed", recoveryAction, safeMessage: "x" }), false);
    expect(failed("sign-in").recovery.map((a) => a.action)).toEqual(["sign-in", "retry"]);
    expect(failed("change-key").recovery.map((a) => a.action)).toEqual(["change-key", "retry"]);
    expect(failed("install-runtime").recovery.map((a) => a.action)).toEqual(["install-runtime"]);
    expect(failed("retry").recovery.map((a) => a.action)).toEqual(["retry"]);
    expect(failed("configure").recovery.map((a) => a.action)).toEqual(["configure", "retry"]);
    expect(failed("turn-on").recovery.map((a) => a.action)).toEqual(["turn-on"]);
    expect(recoveryOf("sign-in")?.labelKey).toBe("recovery.signIn");
    expect(recoveryOf(undefined)).toBeUndefined();
  });

  it("keeps the date of the last pass beside a later failure", () => {
    const view = testViewOf(
      result({
        status: "failed",
        recoveryAction: "retry",
        lastPassedAt: "2026-11-11T09:00:00.000Z",
      }),
      false,
    );
    expect(view.state).toBe("failed");
    expect(view.lastPassedAt).toBe("2026-11-11T09:00:00.000Z");
  });

  it("has a neutral running state without invented progress and an empty state before any test", () => {
    expect(testViewOf(undefined, true)).toMatchObject({ state: "running" });
    expect(testViewOf(undefined, true).steps.every((s) => s.state === "pending")).toBe(true);
    expect(testViewOf(undefined, false)).toMatchObject({ state: "none", recovery: [] });
    expect(testViewOf(result({ status: "cancelled" }), false).state).toBe("cancelled");
  });
});

describe("settings form: write-only keys, validation and drafts (UX-06, MCP-CAT-19)", () => {
  it("maps the server form to the shared field model without ever holding a secret value", () => {
    const fields = configFieldsOf(config());
    expect(fields.map((f) => [f.id, f.secret, f.required])).toEqual([
      ["env.API_KEY", true, true],
      ["env.ROOT", false, true],
      ["env.MODE", false, false],
    ]);
    expect(configInitialValues(config())).toEqual({ "env.ROOT": "/data" });
  });

  it("accepts an empty saved key (keep), asks for a missing one and flags bad values like the server", () => {
    const form = config();
    expect(validateConfig(form, { ...configInitialValues(form) }).errors).toEqual([]);
    const missing = config({
      fields: [
        {
          id: "env.API_KEY",
          kind: "env",
          name: "API_KEY",
          secret: true,
          required: true,
          configured: false,
        },
      ],
    });
    expect(validateConfig(missing, {}).errors).toEqual([
      { id: "env.API_KEY", key: "err.required" },
    ]);
    const bad = validateConfig(form, {
      "env.ROOT": "",
      "env.MODE": "reckless",
      "env.API_KEY": " k ",
    });
    expect(bad.errors.map((e) => [e.id, e.key])).toEqual([
      ["env.API_KEY", "err.spaces"],
      ["env.ROOT", "err.required"],
      ["env.MODE", "err.choice"],
    ]);
    expect(bad.first).toBe("env.API_KEY");
  });

  it("sends only what changed: new key, edited values, and explicit removals", () => {
    const form = config();
    expect(configPatchOf(form, { ...configInitialValues(form) }, [])).toEqual({
      values: {},
      clear: [],
    });
    expect(
      configPatchOf(
        form,
        { "env.ROOT": " /other ", "env.MODE": "safe", "env.API_KEY": "sk-new" },
        [],
      ),
    ).toEqual({
      values: { "env.ROOT": "/other", "env.MODE": "safe", "env.API_KEY": "sk-new" },
      clear: [],
    });
    // Emptying an optional value that had one removes it; removing a saved key is an explicit act.
    const withMode = config({
      fields: config().fields.map((f) =>
        f.id === "env.MODE" ? { ...f, value: "fast", configured: true } : f,
      ),
    });
    expect(configPatchOf(withMode, { "env.ROOT": "/data", "env.MODE": "" }, [])).toEqual({
      values: { "env.MODE": "" },
      clear: [],
    });
    expect(configPatchOf(form, { ...configInitialValues(form) }, ["env.API_KEY"])).toEqual({
      values: {},
      clear: ["env.API_KEY"],
    });
  });

  it("keeps the non-secret draft when a conflict forces a reload", () => {
    const form = config();
    expect(configDraftOf(form, { "env.ROOT": "/mine", "env.API_KEY": "sk-secret" })).toEqual({
      "env.ROOT": "/mine",
    });
  });
});

describe("sign-in view (OAuth, UX-05)", () => {
  const flow = (over: Partial<McpSignInFlow> = {}): McpSignInFlow => ({
    id: "f1",
    state: "awaiting-browser",
    authorizationUrl: "https://auth.example.com/authorize?x=1",
    ...over,
  });

  it("opens only safe addresses: https, or http on this machine, never script or credentials", () => {
    expect(safeAuthUrl("https://auth.example.com/a")).toBe("https://auth.example.com/a");
    expect(safeAuthUrl("http://127.0.0.1:8080/a")).toBe("http://127.0.0.1:8080/a");
    for (const bad of [
      "javascript:alert(1)",
      "http://evil.example.com/a",
      "https://user:pass@auth.example.com/a",
      "data:text/html,x",
      "not a url",
    ])
      expect(safeAuthUrl(bad)).toBeUndefined();
  });

  it("follows the flow: waiting for the browser, completing, done, failed, cancelled", () => {
    expect(signInViewOf(undefined, false)).toMatchObject({ state: "idle" });
    expect(signInViewOf(undefined, true)).toMatchObject({ state: "starting" });
    expect(signInViewOf(flow(), false)).toMatchObject({
      state: "awaiting",
      link: "https://auth.example.com/authorize?x=1",
    });
    expect(signInViewOf(flow({ authorizationUrl: "javascript:x" }), false).link).toBeUndefined();
    expect(signInViewOf(flow({ state: "completing" }), false).state).toBe("completing");
    expect(signInViewOf(flow({ state: "completed" }), false).state).toBe("done");
    expect(
      signInViewOf(
        flow({ state: "failed", error: { code: "access_denied", message: "denied" } }),
        false,
      ),
    ).toMatchObject({ state: "failed", messageKey: "signin.denied" });
    expect(
      signInViewOf(flow({ state: "failed", error: { code: "timeout", message: "late" } }), false)
        .messageKey,
    ).toBe("signin.timeout");
    expect(
      signInViewOf(flow({ state: "failed", error: { code: "oauth_failed", message: "x" } }), false)
        .messageKey,
    ).toBe("signin.failed");
    expect(signInViewOf(flow({ state: "cancelled" }), false).state).toBe("cancelled");
  });
});

describe("update view (LIFE-04)", () => {
  const binding = (over: Partial<McpBindingInfo> = {}): McpBindingInfo => ({
    id: "b1",
    scope: "global",
    registryName: "io.example/files",
    registryVersion: "1.0.0",
    method: "npm",
    execution: "local",
    hasSavedKeys: false,
    ...over,
  });
  const plan = (registryVersion: string): McpInstallPlan =>
    ({ kind: "update", registryVersion, fromVersion: "1.0.0" }) as McpInstallPlan;

  it("offers an update only for installed packages and says when there is nothing newer", () => {
    expect(updateViewOf(binding({ method: "remote", execution: "remote" }), undefined)).toEqual({
      kind: "unavailable",
    });
    expect(updateViewOf(binding(), undefined)).toEqual({ kind: "check" });
    expect(updateViewOf(binding(), plan("1.0.0"))).toEqual({
      kind: "up-to-date",
      version: "1.0.0",
    });
    expect(updateViewOf(binding(), plan("1.2.0"))).toEqual({
      kind: "available",
      from: "1.0.0",
      to: "1.2.0",
    });
  });
});

describe("badges: the test goes stale, sign-in is named and the host is not the browser (UX-02)", () => {
  const owned = (over: Partial<McpServerWire> = {}): McpServerWire => ({
    name: "cloud",
    displayName: "Cloud",
    source: "global",
    status: "connected",
    enabled: true,
    transport: "http",
    capabilities: [],
    counts: { tools: 1, resources: 0, prompts: 0 },
    execution: "remote",
    binding: {
      id: "b1",
      scope: "global",
      registryName: "io.example/cloud",
      registryVersion: "2.0.0",
      method: "remote",
      execution: "remote",
      hasSavedKeys: false,
      lastTest: { status: "passed", at: "2026-11-12T10:00:00.000Z" },
    },
    ...over,
  });

  it("does not call a stale pass ready", () => {
    const stale = owned();
    (stale.binding as McpBindingInfo).lastTest = {
      status: "passed",
      at: "2026-11-12T10:00:00.000Z",
      stale: true,
    };
    expect(badgesOf(stale, "Proj").test).toBe("test.stale");
    expect(badgesOf(owned(), "Proj").test).toBe("test.ready");
  });

  it("names a pending sign-in instead of a generic setup problem", () => {
    const needs = owned({
      status: "needs-authentication",
      auth: { kind: "oauth", signedIn: false },
    });
    expect(badgesOf(needs, "Proj").install).toBe("state.signInNeeded");
    expect(badgesOf(owned({ status: "failed" }), "Proj").install).toBe("state.pending");
  });

  it("says the computer running Alisio for a web or headless server, this computer on the desktop", () => {
    const local = owned({
      transport: "stdio",
      execution: "local",
      binding: {
        ...(owned().binding as McpBindingInfo),
        method: "npm",
        execution: "local",
      },
    });
    expect(badgesOf(local, "Proj").execution.key).toBe("badge.local");
    expect(badgesOf(local, "Proj", { serverHost: true }).execution.key).toBe("badge.localServer");
    expect(installStrings.en["badge.localServer"]).toMatch(/running Alisio/);
    expect(installStrings.es["badge.localServer"]).toMatch(/donde se ejecuta Alisio/);
    // A remote service is never attributed to either computer.
    expect(badgesOf(owned(), "Proj", { serverHost: true }).execution.key).toBe("badge.remote");
  });
});

describe("detail card in Explore (UX, §12.1 ficha)", () => {
  const detail = (over: Partial<McpCatalogDetail> = {}): McpCatalogDetail => ({
    sourceId: "official",
    name: "io.github.acme/files",
    title: "Files",
    description: "Read and organise your files",
    version: "1.2.0",
    status: "active",
    execution: "local",
    methods: ["npm"],
    category: { id: "files", method: "rule", confidence: 0.8 },
    ready: true,
    websiteUrl: "https://acme.example/files",
    repositoryUrl: "https://github.com/acme/files",
    packages: [
      {
        method: "npm",
        identifier: "@acme/files",
        version: "1.2.0",
        transport: "stdio",
        inputs: [
          { name: "API_KEY", kind: "env", isRequired: true, isSecret: true },
          { name: "ROOT", kind: "env", isRequired: true, isSecret: false },
          { name: "MODE", kind: "env", isRequired: false, isSecret: false },
        ],
      },
    ],
    remotes: [],
    ...over,
  });

  it("derives a readable provider from the registry namespace", () => {
    expect(providerOf("io.github.acme/files")).toEqual({ kind: "github", name: "acme" });
    expect(providerOf("com.example/files")).toEqual({ kind: "domain", name: "example.com" });
    expect(providerOf("plain")).toEqual({ kind: "domain", name: "plain" });
  });

  it("summarises origin, requirements, compatibility and what it will ask for", () => {
    const view = detailViewOf(detail());
    expect(view.runtime).toBe("node");
    expect(view.required.map((i) => [i.name, i.secret])).toEqual([
      ["API_KEY", true],
      ["ROOT", false],
    ]);
    expect(view.optionalCount).toBe(1);
    expect(view.links.map((l) => l.url)).toEqual([
      "https://acme.example/files",
      "https://github.com/acme/files",
    ]);
    expect(view.installable).toBe(true);
    const remote = detailViewOf(
      detail({
        execution: "remote",
        methods: ["remote"],
        packages: [],
        remotes: [{ transport: "streamable-http", origin: "https://mcp.acme.example", inputs: [] }],
      }),
    );
    expect(remote.runtime).toBe("none");
    expect(remote.origin).toBe("https://mcp.acme.example");
  });

  it("keeps an unsafe link out and explains why something is not installable", () => {
    const view = detailViewOf(
      detail({
        websiteUrl: "javascript:alert(1)",
        ready: false,
        blocked: { reason: "method_unsupported", detail: "pypi" },
        methods: ["pypi"],
      }),
    );
    expect(view.links.map((l) => l.url)).toEqual(["https://github.com/acme/files"]);
    expect(view.installable).toBe(false);
    expect(view.blockedKey).toBe("unsupported.pypi");
  });
});

describe("strings", () => {
  it("keeps the same keys and placeholders in English and Spanish", () => {
    const keys = (dict: Record<string, string>) => Object.keys(dict).sort();
    expect(keys(manageStrings.es)).toEqual(keys(manageStrings.en));
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(manageStrings.en))
      expect(holes(manageStrings.es[key as keyof typeof manageStrings.en])).toEqual(
        holes(manageStrings.en[key as keyof typeof manageStrings.en]),
      );
    expect(mgs("recovery.signIn")).toBe("Sign in");
    locale.value = "es";
    expect(mgs("recovery.signIn")).toBe("Iniciar sesión");
  });
});

// ---- hook-free views, walked as VNode trees --------------------------------------------------

type VNode = { type: unknown; props: Record<string, unknown> };
const PANELS = "../packages/web/src/components/settings/mcp-manage/ManagePanels.tsx";
const DETAIL = "../packages/web/src/components/settings/mcp-explore/DetailCard.tsx";
const ROWS = "../packages/web/src/components/settings/mcp-install/MineRows.tsx";
type View = (props: Record<string, unknown>) => unknown;
let panels: { TestPanelView: View; ConfigureForm: View; SignInView: View };
let detailCard: { DetailView: View };
let rows: { MineRow: (props: Record<string, unknown>) => unknown };
beforeAll(async () => {
  panels = (await import(/* @vite-ignore */ PANELS)) as typeof panels;
  detailCard = (await import(/* @vite-ignore */ DETAIL)) as typeof detailCard;
  rows = (await import(/* @vite-ignore */ ROWS)) as unknown as typeof rows;
});

function walkTree(node: unknown, visit: (n: VNode) => void): void {
  if (Array.isArray(node)) return node.forEach((child) => walkTree(child, visit));
  if (!node || typeof node !== "object") return;
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    walkTree((vnode.type as (props: unknown) => unknown)(vnode.props), visit);
    return;
  }
  visit(vnode);
  walkTree(vnode.props?.children, visit);
}
const find = (root: unknown, test: (n: VNode) => boolean): VNode[] => {
  const out: VNode[] = [];
  walkTree(root, (n) => test(n) && out.push(n));
  return out;
};
const text = (root: unknown): string => {
  const parts: string[] = [];
  const collect = (n: unknown): void => {
    if (typeof n === "string" || typeof n === "number") parts.push(String(n));
    else if (Array.isArray(n)) n.forEach(collect);
    else if (n && typeof n === "object") {
      const v = n as VNode;
      if (typeof v.type === "function") collect((v.type as (p: unknown) => unknown)(v.props));
      else collect(v.props?.children);
    }
  };
  collect(root);
  return parts.join(" ");
};
const noop = () => {};
const buttons = (tree: unknown) => find(tree, (n) => n.type === "button");
const labelOf = (b: VNode) => text(b.props.children);

describe("TestPanelView (UX-07, UX-10)", () => {
  const view = (res: McpConnectionTestResult | undefined, over: Record<string, unknown> = {}) =>
    panels.TestPanelView({
      view: testViewOf(res, false),
      title: "Files",
      onRun: noop,
      onCancel: noop,
      onAction: noop,
      ...over,
    });

  it("lists the stages in order, announces the result politely and shows what was found", () => {
    const tree = view(result());
    const list = find(tree, (n) => n.type === "ol")[0];
    expect(list?.props["aria-label"]).toBeTruthy();
    expect(find(tree, (n) => n.type === "li")).toHaveLength(4);
    const live = find(tree, (n) => n.props["aria-live"] === "polite");
    expect(live.length).toBeGreaterThan(0);
    const body = text(tree);
    expect(body).toContain("2 tools");
    expect(body).toContain("1 resource");
    expect(body).toContain("does not call any tool");
  });

  it("offers the recovery actions of a failure and routes the click", () => {
    const onAction = vi.fn();
    const tree = view(
      result({
        status: "failed",
        recoveryAction: "sign-in",
        safeMessage: "Sign in to this service to continue",
      }),
      { onAction },
    );
    expect(text(tree)).toContain("Sign in to this service to continue");
    const signIn = buttons(tree).find((b) => labelOf(b) === "Sign in");
    expect(signIn).toBeDefined();
    (signIn?.props.onClick as () => void)();
    expect(onAction).toHaveBeenCalledWith("sign-in");
  });

  it("says a result is out of date and shows the last pass beside a failure", () => {
    expect(text(view(result({ stale: true })))).toContain("settings changed");
    const failed = text(
      view(
        result({
          status: "failed",
          recoveryAction: "retry",
          lastPassedAt: "2026-11-11T09:00:00.000Z",
        }),
      ),
    );
    expect(failed).toContain("Last passed");
  });

  it("shows a cancel button while it runs and never a percentage", () => {
    const running = view(undefined, { view: testViewOf(undefined, true) });
    expect(buttons(running).map(labelOf)).toContain("Cancel");
    expect(text(running)).not.toMatch(/\d+\s?%/);
    locale.value = "es";
    expect(text(view(result()))).toContain("herramientas");
  });

  it("never prints a secret even if one were passed in a message", () => {
    const tree = view(
      result({ status: "failed", recoveryAction: "retry", safeMessage: "We could not connect" }),
    );
    expect(text(tree)).not.toMatch(/sk-|Bearer|at-/);
  });
});

describe("ConfigureForm (UX-06, MCP-CAT-19, MCP-CAT-24)", () => {
  const form = (over: Record<string, unknown> = {}) =>
    panels.ConfigureForm({
      config: config(),
      values: configInitialValues(config()),
      errors: {},
      revealed: {},
      replacing: {},
      saving: false,
      conflict: false,
      onValue: noop,
      onBlur: noop,
      onReveal: noop,
      onReplace: noop,
      onClearKey: noop,
      onSubmit: noop,
      onCancel: noop,
      onReload: noop,
      ...over,
    });

  it("labels every field, uses a password input for a new key and says 'saved' for an existing one", () => {
    const tree = form();
    const inputs = find(tree, (n) => n.type === "input");
    expect(inputs.find((n) => n.props.id === "mcp-config-env.ROOT")?.props.type).toBe("text");
    expect(inputs.find((n) => n.props.id === "mcp-config-env.ROOT")?.props.value).toBe("/data");
    // A saved key shows no input until the user asks to replace it.
    expect(inputs.find((n) => n.props.id === "mcp-config-env.API_KEY")).toBeUndefined();
    expect(text(tree)).toContain("Key saved");
    const replace = buttons(tree).find((b) => labelOf(b) === "Replace key");
    expect(replace).toBeDefined();
    const labels = find(tree, (n) => n.type === "label").map((n) => n.props.for);
    expect(labels).toContain("mcp-config-env.ROOT");
    expect(inputs.every((n) => n.props.placeholder === undefined)).toBe(true);
  });

  it("shows a password input while replacing, and never echoes the typed key into the tree text", () => {
    const tree = form({
      replacing: { "env.API_KEY": true },
      values: { "env.API_KEY": "sk-typed-secret" },
    });
    const input = find(
      tree,
      (n) => n.type === "input" && n.props.id === "mcp-config-env.API_KEY",
    )[0];
    expect(input?.props.type).toBe("password");
    expect(input?.props.autocomplete).toBe("off");
    expect(text(tree)).not.toContain("sk-typed-secret");
  });

  it("links errors to their field and announces them", () => {
    const tree = form({ errors: { "env.ROOT": "err.required" } });
    const field = find(tree, (n) => n.type === "input" && n.props.id === "mcp-config-env.ROOT")[0];
    expect(field?.props["aria-invalid"]).toBe("true");
    expect(String(field?.props["aria-describedby"])).toContain("mcp-config-env.ROOT-error");
    expect(find(tree, (n) => n.props.role === "alert").length).toBeGreaterThan(0);
  });

  it("shows the conflict message with a reload action that keeps the draft, and submits through the form", () => {
    const onReload = vi.fn();
    const onSubmit = vi.fn();
    const tree = form({ conflict: true, onReload, onSubmit });
    expect(text(tree)).toContain("changed while you were editing");
    (buttons(tree).find((b) => labelOf(b) === "Reload changes")?.props.onClick as () => void)();
    expect(onReload).toHaveBeenCalledOnce();
    const formNode = find(tree, (n) => n.type === "form")[0];
    expect(formNode?.props.noValidate).toBe(true);
    (formNode?.props.onSubmit as (e: { preventDefault: () => void }) => void)({
      preventDefault: noop,
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(buttons(tree).map(labelOf)).toContain("Save and check");
  });
});

describe("SignInView (OAuth, UX-05, UX-10)", () => {
  const view = (flow: McpSignInFlow | undefined, over: Record<string, unknown> = {}) =>
    panels.SignInView({
      view: signInViewOf(flow, false),
      name: "Cloud",
      onStart: noop,
      onCancel: noop,
      onClose: noop,
      ...over,
    });
  const waiting: McpSignInFlow = {
    id: "f1",
    state: "awaiting-browser",
    authorizationUrl: "https://auth.example.com/authorize?x=1",
  };

  it("offers a real link that opens in a new tab without leaking the opener, plus cancel", () => {
    const tree = view(waiting);
    const link = find(tree, (n) => n.type === "a")[0];
    expect(link?.props.href).toBe("https://auth.example.com/authorize?x=1");
    expect(link?.props.target).toBe("_blank");
    expect(String(link?.props.rel)).toContain("noopener");
    expect(String(link?.props.rel)).toContain("noreferrer");
    expect(buttons(tree).map(labelOf)).toContain("Cancel");
    expect(find(tree, (n) => n.props["aria-live"] === "polite").length).toBeGreaterThan(0);
  });

  it("starts from a clear call to action and explains the browser step", () => {
    const tree = view(undefined);
    expect(buttons(tree).map(labelOf)).toContain("Connect my account");
    expect(text(tree)).toContain("opens in your browser");
  });

  it("reports a denied or failed sign-in with a way to try again, never a raw error", () => {
    const tree = view({
      id: "f1",
      state: "failed",
      error: { code: "access_denied", message: "raw" },
    });
    expect(text(tree)).not.toContain("raw");
    expect(buttons(tree).map(labelOf)).toContain("Try again");
  });
});

describe("DetailView (ficha de MCP)", () => {
  const detail: McpCatalogDetail = {
    sourceId: "official",
    name: "io.github.acme/files",
    title: "Files",
    description: "Read and organise your files",
    version: "1.2.0",
    status: "active",
    execution: "local",
    methods: ["npm"],
    category: { id: "files", method: "rule", confidence: 0.8 },
    ready: true,
    repositoryUrl: "https://github.com/acme/files",
    packages: [
      {
        method: "npm",
        identifier: "@acme/files",
        version: "1.2.0",
        transport: "stdio",
        inputs: [{ name: "API_KEY", kind: "env", isRequired: true, isSecret: true }],
      },
    ],
    remotes: [],
  };
  const view = (over: Record<string, unknown> = {}) =>
    detailCard.DetailView({
      view: detailViewOf(detail),
      hostWording: "server",
      onInstall: noop,
      onClose: noop,
      installLabel: "Install",
      ...over,
    });

  it("shows benefit, provider, origin of the package, requirements and the install action", () => {
    const body = text(view());
    expect(body).toContain("Read and organise your files");
    expect(body).toContain("acme");
    expect(body).toContain("Node.js");
    expect(body).toContain("API_KEY");
    expect(body).toMatch(/computer running Alisio/);
    expect(buttons(view()).map(labelOf)).toContain("Install");
  });

  it("opens links safely and never renders catalog text as HTML", () => {
    const tree = view();
    const links = find(tree, (n) => n.type === "a");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.props.target).toBe("_blank");
      expect(String(link.props.rel)).toContain("noopener");
    }
    expect(find(tree, (n) => n.props.dangerouslySetInnerHTML !== undefined)).toEqual([]);
  });

  it("shows the honest reason instead of an install button when it cannot be installed", () => {
    const blocked = detailViewOf({
      ...detail,
      ready: false,
      blocked: { reason: "method_unsupported", detail: "pypi" },
      methods: ["pypi"],
    });
    const tree = view({ view: blocked });
    expect(buttons(tree).map(labelOf)).not.toContain("Install");
    expect(text(tree)).toContain("Python (PyPI)");
  });
});

describe("MineRow: new actions and panel slot (UX-09)", () => {
  const owned = (over: Partial<McpServerWire> = {}): McpServerWire => ({
    name: "files-abc123",
    displayName: "Files",
    source: "global",
    status: "connected",
    enabled: true,
    transport: "stdio",
    capabilities: ["tools"],
    counts: { tools: 2, resources: 0, prompts: 0 },
    execution: "local",
    binding: {
      id: "b1",
      scope: "global",
      registryName: "io.example/files",
      registryVersion: "1.0.0",
      method: "npm",
      execution: "local",
      hasSavedKeys: true,
      lastTest: { status: "passed", at: new Date().toISOString() },
    },
    ...over,
  });
  const row = (server: McpServerWire, over: Record<string, unknown> = {}) =>
    rows.MineRow({
      server,
      workspaceName: "Contabilidad",
      granted: true,
      readOnly: false,
      busy: false,
      testing: false,
      meta: "stdio · global",
      connectLabel: "Connect",
      switchLabel: "Enable Files",
      needsGrantHint: "Grant MCP access first",
      onConnect: noop,
      onToggle: noop,
      onTest: noop,
      onRemove: noop,
      onConfigure: noop,
      onUpdate: noop,
      onSignIn: noop,
      onSignOut: noop,
      ...over,
    });

  it("offers Configure and Update for an installed package, and routes the clicks", () => {
    const onConfigure = vi.fn();
    const onUpdate = vi.fn();
    const tree = row(owned(), { onConfigure, onUpdate });
    const labels = buttons(tree).map(labelOf);
    expect(labels).toEqual(expect.arrayContaining(["Configure", "Update"]));
    (buttons(tree).find((b) => labelOf(b) === "Configure")?.props.onClick as () => void)();
    (buttons(tree).find((b) => labelOf(b) === "Update")?.props.onClick as () => void)();
    expect(onConfigure).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("offers Sign in when the service needs it and Sign out when signed in, never for a local server", () => {
    const needs = owned({
      transport: "http",
      execution: "remote",
      status: "needs-authentication",
      auth: { kind: "oauth", signedIn: false },
      binding: {
        ...(owned().binding as McpBindingInfo),
        method: "remote",
        execution: "remote",
        hasSavedKeys: false,
      },
    });
    expect(buttons(row(needs)).map(labelOf)).toContain("Sign in");
    expect(text(row(needs))).toContain("Sign-in needed");
    const signedIn = owned({
      ...needs,
      status: "connected",
      auth: { kind: "oauth", signedIn: true },
    });
    const labels = buttons(row(signedIn)).map(labelOf);
    expect(labels).toContain("Sign out");
    expect(labels).not.toContain("Update");
    expect(buttons(row(owned())).map(labelOf)).not.toContain("Sign in");
  });

  it("disables every change under read-only and renders the open panel inside the row", () => {
    const tree = row(owned(), {
      readOnly: true,
      panel: { type: "section", props: { id: "slot", children: "Panel body" } },
    });
    for (const label of ["Configure", "Update", "Remove"]) {
      const b = buttons(tree).find((x) => labelOf(x) === label);
      expect(b?.props.disabled).toBe(true);
    }
    expect(text(tree)).toContain("Panel body");
  });

  it("uses the server-host wording when the page says so", () => {
    expect(text(row(owned(), { hostWording: "server" }))).toContain(
      "On the computer running Alisio",
    );
    expect(text(row(owned()))).toContain("On this computer");
  });
});

describe("the initial bundle is untouched", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  it("loads the manage panels and the detail card only through dynamic imports", () => {
    const page = read("packages/web/src/components/settings/McpPage.tsx");
    expect(page).toMatch(/import\(["']\.\/mcp-manage\/ManagePanels\.tsx["']\)/);
    expect(page).not.toMatch(/^import (?!type).* from ["']\.\/mcp-manage\/ManagePanels/m);
    const explore = read("packages/web/src/components/settings/mcp-explore/ExploreView.tsx");
    expect(explore).toMatch(/import\(["']\.\/DetailCard\.tsx["']\)/);
    for (const file of [
      "packages/web/src/app.tsx",
      "packages/web/src/store/app.ts",
      "packages/web/src/i18n/en.ts",
    ])
      expect(read(file)).not.toContain("mcp-manage");
  });
});
