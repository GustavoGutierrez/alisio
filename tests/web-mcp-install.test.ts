/**
 * Web side of installing MCP servers (specs/030 phase 3): the pure model (scope default, form
 * validation that mirrors the server, drafts without secrets, job progress and outcomes, the two
 * badge dimensions of D13, scope-aware removal), the EN/ES strings and the lazy loading that keeps
 * the initial bundle inside its budget. No DOM: presentational parts are walked as VNode trees.
 */
import { readFileSync } from "node:fs";
import type {
  McpInstallInputInfo,
  McpInstallJob,
  McpInstallPlan,
  McpServerWire,
} from "@alisio/sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  actionKey,
  answersOf,
  badgesOf,
  defaultScope,
  draftOf,
  errorGuidance,
  fieldIssue,
  jobOutcome,
  jobSteps,
  type Removal,
  removalOf,
  scopeOptions,
  submitKey,
  unsupportedKey,
  validateInputs,
} from "../packages/web/src/components/settings/mcp-install/model.ts";
import { installStrings, ms } from "../packages/web/src/components/settings/mcp-install/strings.ts";
import { locale } from "../packages/web/src/i18n/index.ts";

afterEach(() => {
  locale.value = "en";
});

const input = (over: Partial<McpInstallInputInfo> = {}): McpInstallInputInfo => ({
  id: "env.API_KEY",
  kind: "env",
  name: "API_KEY",
  secret: true,
  required: true,
  ...over,
});

const job = (over: Partial<McpInstallJob> = {}): McpInstallJob => ({
  id: "job_1",
  kind: "install",
  state: "installing",
  alias: "files-abc123",
  registryName: "io.example/files",
  registryVersion: "1.0.0",
  scope: "global",
  createdAt: "2026-11-12T10:00:00Z",
  updatedAt: "2026-11-12T10:00:00Z",
  ...over,
});

const server = (over: Partial<McpServerWire> = {}): McpServerWire => ({
  name: "files-abc123",
  displayName: "Files",
  source: "global",
  status: "connected",
  enabled: true,
  transport: "stdio",
  capabilities: ["tools"],
  counts: { tools: 2, resources: 0, prompts: 0 },
  execution: "local",
  ...over,
});

describe("scope (D4, SCP-01, UX-03)", () => {
  it("preselects the project when one is active and offers both choices with its name", () => {
    expect(defaultScope(true)).toBe("project");
    expect(defaultScope(false)).toBe("global");
    const options = scopeOptions("Contabilidad");
    expect(options.map((o) => o.id)).toEqual(["project", "global"]);
    expect(options[0]?.params).toEqual({ name: "Contabilidad" });
    expect(scopeOptions(undefined).map((o) => o.id)).toEqual(["global"]);
  });
});

describe("form validation mirrors the server and never echoes a secret (UX-06, MCP-CAT-19)", () => {
  it("flags a missing required field, bad choices, numbers, booleans and control characters", () => {
    expect(fieldIssue(input(), "")).toBe("err.required");
    expect(fieldIssue(input({ secret: false, choices: ["a", "b"] }), "z")).toBe("err.choice");
    expect(fieldIssue(input({ secret: false, format: "number" }), "abc")).toBe("err.number");
    expect(fieldIssue(input({ secret: false, format: "boolean" }), "maybe")).toBe("err.boolean");
    expect(fieldIssue(input(), "abc\ndef")).toBe("err.control");
    expect(fieldIssue(input({ secret: false }), "fine")).toBeUndefined();
  });

  it("does not silently trim a secret, but reports surrounding spaces", () => {
    expect(fieldIssue(input(), " sk-123")).toBe("err.spaces");
    expect(answersOf([input({ secret: true })], { "env.API_KEY": "sk-123" })).toEqual({
      "env.API_KEY": "sk-123",
    });
    expect(answersOf([input({ secret: false })], { "env.API_KEY": "  /data " })).toEqual({
      "env.API_KEY": "/data",
    });
  });

  it("ignores empty optional fields and reports the first error to focus", () => {
    const inputs = [
      input({ id: "env.A", name: "A", secret: false }),
      input({ id: "env.B", name: "B", secret: false, required: false }),
      input({ id: "env.C", name: "C" }),
    ];
    const result = validateInputs(inputs, { "env.A": "", "env.B": "", "env.C": "" });
    expect(result.errors.map((e) => e.id)).toEqual(["env.A", "env.C"]);
    expect(result.first).toBe("env.A");
    expect(answersOf(inputs, { "env.A": "x", "env.B": "", "env.C": "k" })).toEqual({
      "env.A": "x",
      "env.C": "k",
    });
    expect(validateInputs(inputs, { "env.A": "x", "env.C": "k" }).errors).toEqual([]);
  });

  it("keeps a draft of the non-secret values only", () => {
    const inputs = [input({ id: "env.A", name: "A", secret: false }), input()];
    expect(draftOf(inputs, { "env.A": "/data", "env.API_KEY": "sk-secret" })).toEqual({
      "env.A": "/data",
    });
  });
});

describe("labels", () => {
  it("says Connect for a remote service and Install for a local one, with a final test button", () => {
    expect(actionKey("remote")).toBe("action.connect");
    expect(actionKey("local")).toBe("action.install");
    expect(submitKey("remote")).toBe("form.submitConnect");
    expect(submitKey("local")).toBe("form.submitInstall");
    expect(ms("form.submitInstall")).toBe("Install and test");
    expect(ms("form.submitConnect")).toBe("Connect and test");
    locale.value = "es";
    expect(ms("form.submitInstall")).toBe("Instalar y comprobar");
    expect(ms("form.submitConnect")).toBe("Conectar y comprobar");
  });

  it("gives every unsupported method an honest explanation with manual guidance", () => {
    for (const reason of [
      "pypi",
      "oci",
      "mcpb",
      "sse",
      "unversioned",
      "lifecycle_scripts",
      "deprecated",
      "requires_arguments",
    ])
      expect(installStrings.en[unsupportedKey(reason)]).toMatch(/\S/);
    expect(unsupportedKey("something-new")).toBe("unsupported.other");
  });
});

describe("job progress without invented percentages (UX-04, UX-10)", () => {
  it("marks the steps before the active one done", () => {
    expect(jobSteps(job({ state: "installing" })).map((s) => [s.id, s.state])).toEqual([
      ["prepare", "active"],
      ["configure", "pending"],
      ["connect", "pending"],
    ]);
    expect(jobSteps(job({ state: "connecting" })).map((s) => s.state)).toEqual([
      "done",
      "done",
      "active",
    ]);
    expect(jobSteps(job({ state: "completed" })).map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
    ]);
  });

  it("derives the outcome and its actions from the job", () => {
    expect(jobOutcome(job({ state: "awaiting-consent" })).kind).toBe("waiting-consent");
    expect(jobOutcome(job({ state: "installing" }))).toMatchObject({
      kind: "running",
      actions: ["cancel"],
    });
    expect(
      jobOutcome(
        job({
          state: "completed",
          result: { connected: true, counts: { tools: 2, resources: 1, prompts: 0 } },
        }),
      ),
    ).toMatchObject({ kind: "connected", actions: ["close"] });
    expect(
      jobOutcome(
        job({
          state: "completed",
          result: { connected: false, status: "failed", diagnostic: "x" },
        }),
      ),
    ).toMatchObject({ kind: "needs-attention", actions: ["test", "close"] });
    expect(
      jobOutcome(
        job({
          state: "completed",
          result: { connected: false, status: "needs-authentication", signIn: "available" },
        }),
      ).kind,
    ).toBe("sign-in");
    expect(
      jobOutcome(job({ state: "failed", error: { code: "mcp_install_failed", message: "m" } })),
    ).toMatchObject({
      kind: "failed",
      actions: ["retry", "close"],
    });
    expect(jobOutcome(job({ state: "cancelled" })).kind).toBe("cancelled");
  });

  it("maps API errors to a plain cause and the next action (UX-08)", () => {
    expect(errorGuidance("mcp_scope_untrusted")).toMatchObject({ action: "choose-global" });
    expect(errorGuidance("mcp_config_conflict")).toMatchObject({ action: "replan" });
    expect(errorGuidance("mcp_plan_expired")).toMatchObject({ action: "replan" });
    expect(errorGuidance("mcp_runtime_missing")).toMatchObject({ action: "recheck" });
    expect(errorGuidance("mcp_method_unsupported", "lifecycle_scripts")).toMatchObject({
      action: "manual",
    });
    expect(errorGuidance("mcp_not_permitted")).toMatchObject({ action: "none" });
    expect(errorGuidance("something_else").textKey).toBe("error.generic");
  });
});

describe("two separate dimensions: where it runs and where it is available (D13, UX-02)", () => {
  const cases: Array<[McpServerWire["execution"], "global" | "project", string, string]> = [
    ["local", "global", "On this computer", "Global · All my projects"],
    ["local", "project", "On this computer", "Project · Contabilidad"],
    ["remote", "global", "Remote service", "Global · All my projects"],
    ["remote", "project", "Remote service", "Project · Contabilidad"],
  ];
  for (const [execution, scope, run, where] of cases)
    it(`shows ${execution} × ${scope} with text and an icon`, () => {
      const badges = badgesOf(
        server({ execution, source: scope, transport: execution === "local" ? "stdio" : "http" }),
        "Contabilidad",
      );
      expect(ms(badges.execution.key)).toBe(run);
      expect(ms(badges.scope.key, badges.scope.params)).toBe(where);
      expect(badges.execution.icon).toBe(execution === "local" ? "computer" : "cloud");
    });

  it("keeps installation, connection and test state apart", () => {
    const tested = server({
      binding: {
        id: "b1",
        scope: "global",
        registryName: "io.example/files",
        registryVersion: "1.0.0",
        method: "npm",
        execution: "local",
        hasSavedKeys: false,
        lastTest: { status: "passed", at: "2026-11-12T10:00:00Z" },
      },
    });
    expect(badgesOf(tested, "x")).toMatchObject({ install: "state.connected", test: "test.ready" });
    expect(badgesOf(server({ status: "failed" }), "x")).toMatchObject({
      install: "state.pending",
      test: "test.unchecked",
    });
    expect(badgesOf(server({ status: "disconnected" }), "x").install).toBe("state.installed");
    const failed = server({
      status: "failed",
      binding: {
        ...(tested.binding as NonNullable<typeof tested.binding>),
        lastTest: { status: "failed", at: "2026-11-12T10:00:00Z" },
      },
    });
    expect(badgesOf(failed, "x").test).toBe("test.attention");
  });

  it("infers local or remote from the transport for entries without the field", () => {
    const old = server();
    delete old.execution;
    expect(badgesOf({ ...old, transport: "http" }, "x").execution.icon).toBe("cloud");
  });
});

describe("removal says exactly what will happen (UX-09)", () => {
  const binding = (scope: "global" | "project", over = {}) => ({
    id: "b1",
    scope,
    registryName: "io.example/files",
    registryVersion: "1.0.0",
    method: "npm" as const,
    execution: "local" as const,
    hasSavedKeys: true,
    ...over,
  });

  it("uses the global wording for a global binding and offers deleting saved keys", () => {
    const plan = removalOf(server({ binding: binding("global") }), "Contabilidad") as Removal;
    expect(ms(plan.bodyKey, plan.params)).toBe(
      "It will be removed from all projects that use this global setting.",
    );
    expect(plan.scope).toBe("global");
    expect(plan.secretsOption).toBe(true);
    expect(plan.revealsGlobal).toBe(false);
  });

  it("names the project for a project binding and announces a revealed global one", () => {
    const plan = removalOf(
      server({ source: "project", binding: binding("project", { revealsGlobal: true }) }),
      "Contabilidad",
    ) as Removal;
    expect(ms(plan.bodyKey, plan.params)).toBe("It will be removed only from Contabilidad.");
    expect(plan.revealsGlobal).toBe(true);
    expect(ms("remove.reveals")).toMatch(/global/i);
  });

  it("says Disconnect for a remote service, never promising to cancel an account", () => {
    const plan = removalOf(
      server({
        execution: "remote",
        transport: "http",
        binding: binding("global", { execution: "remote", method: "remote" }),
      }),
      "x",
    ) as Removal;
    expect(plan.confirmKey).toBe("remove.confirmDisconnect");
    expect(ms("remove.account")).toMatch(/account|subscription/i);
  });

  it("offers no removal for an entry the installer does not own", () => {
    expect(removalOf(server(), "x")).toBeUndefined();
  });
});

describe("strings", () => {
  it("has the same keys and placeholders in English and Spanish", () => {
    const { en, es } = installStrings;
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>)
      expect(placeholders(es[key]), key).toEqual(placeholders(en[key]));
  });
});

describe("the initial bundle is untouched", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  it("loads the install panel and its strings only through dynamic imports", () => {
    const explore = read("packages/web/src/components/settings/mcp-explore/ExploreView.tsx");
    expect(explore).toMatch(/import\(["']\.\.\/mcp-install\/InstallPanel\.tsx["']\)/);
    expect(explore).not.toMatch(/^import (?!type).* from ["']\.\.\/mcp-install\/InstallPanel/m);
    // Nothing outside the settings chunk imports the install modules.
    for (const file of [
      "packages/web/src/app.tsx",
      "packages/web/src/store/app.ts",
      "packages/web/src/i18n/en.ts",
    ])
      expect(read(file)).not.toContain("mcp-install");
  });
});

beforeAll(() => {
  locale.value = "en";
});

// ---- the hook-free parts of the panel, walked as VNode trees (no DOM) ---------------------------

type VNode = { type: unknown; props: Record<string, unknown> };
const PANEL = "../packages/web/src/components/settings/mcp-install/InstallPanel.tsx";
const ROWS = "../packages/web/src/components/settings/mcp-install/MineRows.tsx";
let rows: { MineRow: (props: Record<string, unknown>) => unknown };
let panel: {
  InstallForm: (props: Record<string, unknown>) => unknown;
  JobView: (props: Record<string, unknown>) => unknown;
};
beforeAll(async () => {
  panel = (await import(/* @vite-ignore */ PANEL)) as unknown as typeof panel;
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

const plan = (over: Partial<McpInstallPlan> = {}): McpInstallPlan => ({
  planId: "plan_1",
  digest: "d".repeat(64),
  expiresAt: "2026-11-12T10:10:00Z",
  kind: "install",
  alias: "files-abc123",
  scope: "global",
  registryName: "io.example/files",
  registryVersion: "1.0.0",
  title: "Files",
  method: "npm",
  execution: "local",
  requiredInputs: [],
  optionalInputs: [],
  prerequisites: { runtime: "system", npm: true },
  requiresConsent: false,
  ...over,
});

const noop = () => {};
const formProps = (over: Record<string, unknown> = {}) => ({
  plan: plan(),
  values: {},
  errors: {},
  revealed: {},
  consent: { allow: false, remember: false },
  showOptional: false,
  submitting: false,
  where: "All my projects",
  onValue: noop,
  onBlur: noop,
  onReveal: noop,
  onConsent: noop,
  onToggleOptional: noop,
  onSubmit: noop,
  onCancel: noop,
  ...over,
});

describe("InstallForm (UX-05, UX-06, UX-10)", () => {
  const secret = input({ description: "Create one in your account" });
  const folder = input({ id: "env.ROOT", name: "ROOT", secret: false });

  it("asks only for the required fields: labels, password for a secret, no placeholder-only fields", () => {
    const tree = panel.InstallForm(
      formProps({ plan: plan({ requiredInputs: [secret, folder] }) }) as never,
    );
    const inputs = find(tree, (n) => n.type === "input");
    const byId = (id: string) => inputs.find((n) => n.props.id === `mcp-field-${id}`);
    expect(byId("env.API_KEY")?.props.type).toBe("password");
    expect(byId("env.API_KEY")?.props.autocomplete).toBe("off");
    expect(byId("env.ROOT")?.props.type).toBe("text");
    // Every field has a real label bound to it, and the secret says it is saved protected.
    const labels = find(tree, (n) => n.type === "label").map((n) => n.props.for);
    expect(labels).toEqual(expect.arrayContaining(["mcp-field-env.API_KEY", "mcp-field-env.ROOT"]));
    expect(text(tree)).toContain("saved protected on this computer");
    expect(text(tree)).toContain("Create one in your account");
    expect(inputs.every((n) => n.props.placeholder === undefined)).toBe(true);
  });

  it("links errors to their field and announces them, without the value", () => {
    const tree = panel.InstallForm(
      formProps({
        plan: plan({ requiredInputs: [secret] }),
        values: { "env.API_KEY": "sk-should-not-appear" },
        errors: { "env.API_KEY": "err.required" },
      }) as never,
    );
    const field = find(
      tree,
      (n) => n.type === "input" && n.props.id === "mcp-field-env.API_KEY",
    )[0];
    expect(field?.props["aria-invalid"]).toBe("true");
    expect(String(field?.props["aria-describedby"])).toContain("mcp-field-env.API_KEY-error");
    const alerts = find(tree, (n) => n.props.role === "alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(text(alerts)).toContain("This field is required.");
    expect(text(tree)).not.toContain("sk-should-not-appear");
  });

  it("collapses optional settings and reveals them on request", () => {
    const optional = input({ id: "env.MODE", name: "MODE", secret: false, required: false });
    const closed = panel.InstallForm(
      formProps({ plan: plan({ optionalInputs: [optional] }) }) as never,
    );
    expect(find(closed, (n) => n.props.id === "mcp-field-env.MODE")).toEqual([]);
    const toggle = find(
      closed,
      (n) => n.type === "button" && n.props["aria-expanded"] === false,
    )[0];
    expect(toggle).toBeDefined();
    const open = panel.InstallForm(
      formProps({ plan: plan({ optionalInputs: [optional] }), showOptional: true }) as never,
    );
    expect(find(open, (n) => n.props.id === "mcp-field-env.MODE")).toHaveLength(1);
  });

  it("integrates the existing consent without preselecting it or the permanent choice", () => {
    const needed = panel.InstallForm(formProps({ plan: plan({ requiresConsent: true }) }));
    const boxes = find(needed, (n) => n.type === "input" && n.props.type === "checkbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.props.checked).toBe(false);
    const submit = find(needed, (n) => n.type === "button" && n.props.type === "submit")[0];
    expect(submit?.props.disabled).toBe(true);
    const allowed = panel.InstallForm(
      formProps({
        plan: plan({ requiresConsent: true }),
        consent: { allow: true, remember: false },
      }) as never,
    );
    const both = find(allowed, (n) => n.type === "input" && n.props.type === "checkbox");
    expect(both.map((n) => n.props.checked)).toEqual([true, false]);
    expect(
      find(allowed, (n) => n.type === "button" && n.props.type === "submit")[0]?.props.disabled,
    ).toBe(false);
    // Nothing about consent when it is already granted.
    expect(find(panel.InstallForm(formProps()), (n) => n.props.type === "checkbox")).toEqual([]);
  });

  it("ends with the test button in both languages and for both executions", () => {
    const local = panel.InstallForm(formProps());
    expect(text(local)).toContain("Install and test");
    const remote = panel.InstallForm(
      formProps({
        plan: plan({ execution: "remote", method: "remote", origin: "https://mcp.example.com" }),
      }) as never,
    );
    expect(text(remote)).toContain("Connect and test");
    expect(text(remote)).toContain("https://mcp.example.com");
    locale.value = "es";
    expect(text(panel.InstallForm(formProps()))).toContain("Instalar y comprobar");
    expect(text(panel.InstallForm(formProps({ plan: plan({ execution: "remote" }) })))).toContain(
      "Conectar y comprobar",
    );
  });

  it("submits through the form and shows the scope it will be added to", () => {
    const onSubmit = vi.fn();
    const tree = panel.InstallForm(
      formProps({ onSubmit, where: "Project · Contabilidad" }) as never,
    );
    const form = find(tree, (n) => n.type === "form")[0];
    expect(form?.props.noValidate).toBe(true);
    (form?.props.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: noop });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(text(tree)).toContain("Project · Contabilidad");
  });
});

describe("JobView (UX-04, UX-07, UX-08, UX-10)", () => {
  const view = (j: McpInstallJob, over: Record<string, unknown> = {}) =>
    panel.JobView({
      job: j,
      title: "Files",
      onCancel: noop,
      onClose: noop,
      onRetry: noop,
      onTest: noop,
      onConsent: noop,
      ...over,
    });

  it("shows steps and a cancel control while it runs, announced politely, with no percentage", () => {
    const tree = view(job({ state: "configuring" }));
    expect(find(tree, (n) => n.type === "li")).toHaveLength(3);
    expect(find(tree, (n) => n.props["aria-live"] === "polite").length).toBeGreaterThan(0);
    expect(text(tree)).not.toMatch(/\d+\s?%/);
    expect(text(tree)).toContain("Cancel");
  });

  it("keeps the installation visible and offers to check the connection when only that failed", () => {
    const tree = view(
      job({
        state: "completed",
        result: { connected: false, status: "failed", diagnostic: "Connection failed" },
      }),
    );
    expect(text(tree)).toContain("Added, but the connection is not complete yet.");
    expect(text(tree)).toContain("Check connection");
    const onTest = vi.fn();
    const clickable = find(
      view(job({ state: "completed", result: { connected: false } }), { onTest }),
      (n) => n.type === "button",
    );
    (
      clickable.find((b) => text(b.props.children) === "Check connection")?.props
        .onClick as () => void
    )();
    expect(onTest).toHaveBeenCalledOnce();
  });

  it("offers to connect the account when a service needs a sign-in, and a failure offers retry", () => {
    expect(
      text(
        view(
          job({
            state: "completed",
            result: { connected: false, status: "needs-authentication", signIn: "available" },
          }),
        ),
      ),
    ).toContain("needs you to sign in");
    const failed = view(
      job({
        state: "failed",
        error: { code: "mcp_install_failed", message: "npm could not download" },
      }),
    );
    expect(text(failed)).toContain("It could not be added.");
    expect(text(failed)).toContain("Try again");
  });

  it("reports counts of what the server offers when it connected", () => {
    const tree = view(
      job({
        state: "completed",
        result: { connected: true, counts: { tools: 2, resources: 1, prompts: 0 } },
      }),
    );
    expect(text(tree)).toContain("2 tools, 1 resources and 0 prompts");
  });
});

describe("MineRow: two dimensions, test state and scope-aware actions (D13, UX-09)", () => {
  const owned = (scope: "global" | "project", execution: "local" | "remote", over = {}) =>
    server({
      source: scope,
      execution,
      transport: execution === "local" ? "stdio" : "http",
      binding: {
        id: "b1",
        scope,
        registryName: "io.example/files",
        registryVersion: "1.0.0",
        method: execution === "local" ? "npm" : "remote",
        execution,
        hasSavedKeys: false,
        lastTest: { status: "passed", at: new Date().toISOString() },
        ...over,
      },
    });
  const row = (s: McpServerWire, over: Record<string, unknown> = {}) =>
    rows.MineRow({
      server: s,
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
      ...over,
    });

  it("shows where it runs and where it is available as text, in both languages", () => {
    const combos: Array<["global" | "project", "local" | "remote", string[]]> = [
      ["global", "local", ["On this computer", "Global · All my projects"]],
      ["project", "local", ["On this computer", "Project · Contabilidad"]],
      ["global", "remote", ["Remote service", "Global · All my projects"]],
      ["project", "remote", ["Remote service", "Project · Contabilidad"]],
    ];
    for (const [scope, execution, expected] of combos) {
      const tree = text(row(owned(scope, execution)));
      for (const label of expected) expect(tree).toContain(label);
    }
    locale.value = "es";
    const es = text(row(owned("project", "remote")));
    expect(es).toContain("Servicio remoto");
    expect(es).toContain("Proyecto · Contabilidad");
    expect(es).toContain("Listo para usar");
  });

  it("offers check connection and a scope-aware remove only for what the installer owns", () => {
    const owned1 = row(owned("global", "local"));
    const labels = find(owned1, (n) => n.type === "button").map((b) => text(b.props.children));
    expect(labels).toEqual(expect.arrayContaining(["Check connection", "Remove"]));
    const remote = text(row(owned("global", "remote")));
    expect(remote).toContain("Disconnect");
    const manual = row(server({ editable: true }));
    const manualLabels = find(manual, (n) => n.type === "button").map((b) =>
      text(b.props.children),
    );
    expect(manualLabels).not.toContain("Remove");
    expect(manualLabels).not.toContain("Check connection");
    expect(text(manual)).toContain("Set up in a configuration file");
  });

  it("disables removal under read-only and testing without consent, and shows progress while testing", () => {
    const readOnly = find(
      row(owned("global", "local"), { readOnly: true }),
      (n) => n.type === "button",
    );
    expect(
      readOnly
        .filter((b) => ["Remove", "Check connection"].includes(text(b.props.children)))
        .every((b) => b.props.disabled),
    ).toBe(true);
    const noConsent = find(
      row(owned("global", "local"), { granted: false }),
      (n) => n.type === "button",
    );
    expect(
      noConsent.find((b) => text(b.props.children) === "Check connection")?.props.disabled,
    ).toBe(true);
    expect(text(row(owned("global", "local"), { testing: true }))).toContain("Checking…");
  });

  it("keeps a failed test visible without calling the server ready", () => {
    const failed = owned("global", "local", {
      lastTest: { status: "failed", at: new Date().toISOString(), diagnostic: "Connection failed" },
    });
    failed.status = "failed";
    const tree = text(row(failed));
    expect(tree).toContain("Needs attention");
    expect(tree).toContain("Setup pending");
    expect(tree).not.toContain("Ready to use");
  });
});
