/**
 * TUI `/connect` sign-in conductor (specs/025 §5.7, OA-AC-34, 35 and the headless half of OA-AC-26):
 * the method picker, the flow driver with its prompts and cancel, the unofficial notice, sign out
 * and the redaction of the errors the TUI prints (P-03). The conductor talks to the terminal only
 * through a small port, so these tests drive it with a scripted fake and a real credential store.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSettingsStore, registerSecret } from "@alisio/core";
import type { ProviderAuthContext, ProviderAuthMethod, ProviderOAuthCredential } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConnectOAuthUi,
  connectFieldsFor,
  describeFailure,
  hookFailureLine,
  pickConnectMethod,
  runConnectOAuth,
  signOut,
  UNOFFICIAL_NOTICE,
} from "../packages/cli/src/tui/connect-oauth.ts";

const ACCESS = "access-tui-0123456789";
const REFRESH = "refresh-tui-0123456789";
const CRED: ProviderOAuthCredential = {
  type: "oauth",
  access: ACCESS,
  refresh: REFRESH,
  expires: 1_900_000_000_000,
  metadata: { hostId: "host-1" },
};
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OSJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const newStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "alisio-connect-oauth-"));
  roots.push(root);
  return { root, store: new ProviderSettingsStore(root) };
};

const method = (
  start: (ctx: ProviderAuthContext) => Promise<ProviderOAuthCredential>,
  extra: Partial<ProviderAuthMethod> = {},
): ProviderAuthMethod => ({
  id: "web",
  label: "Sign in with Acme",
  kind: "oauth",
  start,
  ...extra,
});

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

interface FakeUi extends ConnectOAuthUi {
  notices: string[];
  inputs: Array<{ label: string; secret: boolean; placeholder: string; hint?: string }>;
  choices: Array<{ title: string; items: Array<{ value: string; label: string }> }>;
  waits: { opened: number; closed: number };
  /** Resolves the "Esc" of the currently shown wait picker. */
  pressEscOnWait(): void;
}
/** `answers` feed `askInput` in order (`undefined` = Esc); `picks` feed `askChoice` (a value, or undefined = Esc). */
function fakeUi(script: {
  answers?: Array<string | undefined>;
  picks?: Array<string | undefined>;
}) {
  const answers = [...(script.answers ?? [])];
  const picks = [...(script.picks ?? [])];
  let escape = deferred();
  const ui: FakeUi = {
    notices: [],
    inputs: [],
    choices: [],
    waits: { opened: 0, closed: 0 },
    async askInput(input) {
      ui.inputs.push(input);
      return answers.shift();
    },
    async askChoice(title, items) {
      ui.choices.push({ title, items });
      return picks.shift();
    },
    notice: (text) => void ui.notices.push(text),
    beginWait() {
      ui.waits.opened++;
      escape = deferred();
      return {
        cancelled: escape.promise,
        close: () => void ui.waits.closed++,
      };
    },
    pressEscOnWait: () => escape.resolve(),
  };
  return ui;
}
const text = (ui: FakeUi) => ui.notices.join("\n");

const SECRET_FIELD = { key: "apiKey", label: "API key", kind: "secret", required: true } as const;
const URL_FIELD = { key: "baseUrl", label: "Base URL", kind: "url", required: false } as const;

describe("method picker (OA-AC-34)", () => {
  it("does not ask when the provider declares no sign-in method", async () => {
    const ui = fakeUi({});
    const choice = await pickConnectMethod({
      registration: { name: "Plain", fields: [SECRET_FIELD] },
      ui,
    });
    expect(choice).toEqual({ kind: "api_key" });
    expect(ui.choices).toHaveLength(0);
  });

  it("offers Sign in only, and no API key entry, when the provider has no secret field", async () => {
    const m = method(async () => CRED);
    const ui = fakeUi({ picks: ["sign_in:web"] });
    const choice = await pickConnectMethod({
      registration: { name: "Acme", fields: [URL_FIELD], auth: [m] },
      ui,
    });
    expect(choice).toEqual({ kind: "sign_in", method: m });
    const labels = ui.choices[0]?.items.map((item) => item.label) ?? [];
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Sign in");
    expect(labels.join("\n")).not.toContain("API key");
  });

  it("offers Enter API key as well when the provider has a secret field", async () => {
    const m = method(async () => CRED);
    const ui = fakeUi({ picks: ["api_key"] });
    const choice = await pickConnectMethod({
      registration: { name: "Acme", fields: [SECRET_FIELD], auth: [m] },
      ui,
    });
    expect(choice).toEqual({ kind: "api_key" });
    const labels = ui.choices[0]?.items.map((item) => item.label) ?? [];
    expect(labels.some((label) => label.includes("Sign in"))).toBe(true);
    expect(labels.some((label) => label.includes("Enter API key"))).toBe(true);
  });

  it("tags an unofficial method and offers Sign out only with a stored session", async () => {
    const m = method(async () => CRED, { unofficial: true });
    const without = fakeUi({ picks: [undefined] });
    await pickConnectMethod({ registration: { name: "Acme", fields: [], auth: [m] }, ui: without });
    const labelsWithout = without.choices[0]?.items.map((item) => item.label) ?? [];
    expect(labelsWithout.join("\n")).toContain("unofficial");
    expect(without.choices[0]?.items.some((item) => item.value === "sign_out")).toBe(false);

    const withSession = fakeUi({ picks: ["sign_out"] });
    const choice = await pickConnectMethod({
      registration: { name: "Acme", fields: [], auth: [m] },
      session: { state: "ok" },
      ui: withSession,
    });
    expect(choice).toEqual({ kind: "sign_out" });
    const expired = fakeUi({ picks: [undefined] });
    await pickConnectMethod({
      registration: { name: "Acme", fields: [], auth: [m] },
      session: { state: "needs_sign_in" },
      ui: expired,
    });
    expect(expired.choices[0]?.items.map((item) => item.label).join("\n")).toContain("again");
  });

  it("returns undefined when the user presses Esc on the picker", async () => {
    const m = method(async () => CRED);
    const ui = fakeUi({ picks: [undefined] });
    expect(
      await pickConnectMethod({
        registration: { name: "Acme", fields: [SECRET_FIELD], auth: [m] },
        ui,
      }),
    ).toBeUndefined();
  });

  it("does not block on a required secret field once the user chose to sign in", () => {
    const registration = { name: "Acme", fields: [SECRET_FIELD, URL_FIELD] };
    const m = method(async () => CRED);
    expect(
      connectFieldsFor(registration, { kind: "sign_in", method: m }).map((f) => f.key),
    ).toEqual(["baseUrl"]);
    expect(connectFieldsFor(registration, { kind: "api_key" }).map((f) => f.key)).toEqual([
      "apiKey",
      "baseUrl",
    ]);
  });
});

describe("running a sign-in (OA-AC-34)", () => {
  it("shows the steps as text, labels the prompt only with the plugin's message, and stores the session", async () => {
    const { store } = await newStore();
    const ui = fakeUi({ answers: ["pasted-redirect-0123456789"] });
    let answer: string | undefined;
    const m = method(async (ctx) => {
      ctx.show({
        type: "device_code",
        verificationUri: "https://auth.example.com/device",
        userCode: "ABCD-1234",
        expiresInSeconds: 600,
      });
      ctx.show({
        type: "auth_url",
        url: "https://auth.example.com/authorize?x=1",
        instructions: "Use ssh -L",
      });
      ctx.show({ type: "progress", message: "Waiting for the browser" });
      answer = await ctx.prompt({
        message: "Paste the final URL",
        placeholder: "http://...",
        secret: true,
      });
      return { ...CRED, metadata: { hostId: "host-1" } };
    });
    const result = await runConnectOAuth({
      store,
      profile: "acme",
      registration: { id: "acme", name: "Acme" },
      method: m,
      ui,
    });
    expect(result.status).toBe("succeeded");
    expect(answer).toBe("pasted-redirect-0123456789");
    const shown = text(ui);
    expect(shown).toContain("https://auth.example.com/device");
    expect(shown).toContain("ABCD-1234");
    expect(shown).toContain("https://auth.example.com/authorize?x=1");
    expect(shown).toContain("Use ssh -L");
    expect(shown).toContain("Waiting for the browser");
    expect(ui.inputs).toHaveLength(1);
    expect(ui.inputs[0]?.label).toBe("Paste the final URL");
    expect(ui.inputs[0]?.secret).toBe(true);
    expect(ui.inputs[0]?.placeholder).toBe("http://...");
    const stored = await store.getOAuth("acme", "acme");
    expect(stored?.access).toBe(ACCESS);
    expect(stored?.method).toBe("web");
    // Every wait picker that was opened was closed again.
    expect(ui.waits.opened).toBeGreaterThan(0);
    expect(ui.waits.closed).toBe(ui.waits.opened);
  });

  it("never prints a token, a pasted answer or an authorization code", async () => {
    const { store } = await newStore();
    const ui = fakeUi({
      answers: ["http://127.0.0.1:1455/cb?code=secretcode-0123456789&state=s-0123456789"],
    });
    const m = method(async (ctx) => {
      ctx.show({ type: "progress", message: "Exchanging" });
      await ctx.prompt({ message: "Paste the URL" });
      throw new Error(`exchange failed for secretcode-0123456789 with ${JWT} and ${ACCESS}`);
    });
    registerSecret(ACCESS);
    const result = await runConnectOAuth({
      store,
      profile: "acme",
      registration: { id: "acme", name: "Acme" },
      method: m,
      ui,
    });
    expect(result.status).toBe("failed");
    const everything = `${text(ui)}\n${result.message ?? ""}`;
    expect(everything).not.toContain("secretcode-0123456789");
    expect(everything).not.toContain(JWT);
    expect(everything).not.toContain(ACCESS);
    expect(await store.getOAuthEntry("acme")).toBeUndefined();
  });

  it("Esc on a prompt cancels the flow, aborts the method's signal and stores nothing", async () => {
    const { store } = await newStore();
    const ui = fakeUi({ answers: [undefined] });
    let aborted = false;
    const m = method(async (ctx) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      const value = await ctx.prompt({ message: "Paste it" });
      // Cancelling aborts the signal before the prompt settles: a method must stop at once.
      if (value === undefined || ctx.signal.aborted) throw new Error("aborted");
      return CRED;
    });
    const result = await runConnectOAuth({
      store,
      profile: "acme",
      registration: { id: "acme", name: "Acme" },
      method: m,
      ui,
    });
    expect(result.status).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(await store.getOAuthEntry("acme")).toBeUndefined();
    expect(ui.waits.closed).toBe(ui.waits.opened);
  });

  it("Esc on the waiting picker cancels a flow that is waiting for the browser", async () => {
    const { store } = await newStore();
    const ui = fakeUi({});
    const started = deferred();
    let aborted = false;
    const m = method(
      (ctx) =>
        new Promise((_, reject) => {
          started.resolve();
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const running = runConnectOAuth({
      store,
      profile: "acme",
      registration: { id: "acme", name: "Acme" },
      method: m,
      ui,
    });
    await started.promise;
    // The wait picker is on screen while the browser flow runs.
    for (let i = 0; i < 50 && ui.waits.opened === 0; i++)
      await new Promise((r) => setTimeout(r, 2));
    expect(ui.waits.opened).toBe(1);
    ui.pressEscOnWait();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(ui.waits.closed).toBe(ui.waits.opened);
  });

  it("offers a loopback only when the terminal is not an SSH session", async () => {
    const seen: Array<boolean> = [];
    const m = method(async (ctx) => {
      seen.push(typeof ctx.loopback === "function");
      return CRED;
    });
    for (const env of [
      {},
      { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
      { SSH_TTY: "/dev/pts/1" },
    ]) {
      const { store } = await newStore();
      await runConnectOAuth({
        store,
        profile: "acme",
        registration: { id: "acme", name: "Acme" },
        method: m,
        ui: fakeUi({}),
        env,
      });
    }
    expect(seen).toEqual([true, false, false]);
  });

  it("prints a plugin's text as plain text: terminal control sequences are stripped", async () => {
    const { store } = await newStore();
    const ui = fakeUi({});
    const m = method(async (ctx) => {
      ctx.show({ type: "progress", message: "Step\u001b[2J\u001b]0;pwned\u0007 done\u0000" });
      return CRED;
    });
    await runConnectOAuth({
      store,
      profile: "acme",
      registration: { id: "acme", name: "Acme" },
      method: m,
      ui,
    });
    // eslint-disable-next-line no-control-regex
    expect(text(ui)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text(ui)).toContain("done");
  });
});

describe("unofficial methods (OA-AC-35)", () => {
  it("shows the host's generic notice and does not start without a yes", async () => {
    const { store } = await newStore();
    let started = false;
    const m = method(
      async () => {
        started = true;
        return CRED;
      },
      { unofficial: true },
    );
    const ui = fakeUi({ picks: ["no"] });
    const result = await runConnectOAuth({
      store,
      profile: "acme",
      registration: { id: "acme", name: "Acme" },
      method: m,
      ui,
    });
    expect(started).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(ui.choices[0]?.title).toContain(UNOFFICIAL_NOTICE);
    expect(ui.choices[0]?.items.map((item) => item.value)).toEqual(["yes", "no"]);
    expect(UNOFFICIAL_NOTICE).not.toMatch(/chatgpt|openai|siwc/i);
  });

  it("starts after a yes, and an official method asks nothing", async () => {
    const { store } = await newStore();
    const unofficial = fakeUi({ picks: ["yes"] });
    const result = await runConnectOAuth({
      store,
      profile: "acme",
      registration: { id: "acme", name: "Acme" },
      method: method(async () => CRED, { unofficial: true }),
      ui: unofficial,
    });
    expect(result.status).toBe("succeeded");

    const official = fakeUi({});
    await runConnectOAuth({
      store,
      profile: "acme2",
      registration: { id: "acme", name: "Acme" },
      method: method(async () => CRED),
      ui: official,
    });
    expect(official.choices).toHaveLength(0);
  });
});

describe("sign out (OA-AC-35)", () => {
  it("removes the session of the profile only, with a text that carries no token", async () => {
    const { store, root } = await newStore();
    await store.setOAuth("acme", CRED, { method: "web", provider: "acme" });
    await store.setOAuth("other", CRED, { method: "web", provider: "acme" });
    await store.setCredentials("acme", { apiKey: "sk-keep-this-key-0123456789" });
    const ui = fakeUi({});
    expect(await signOut({ store, profile: "acme", ui })).toBe(true);
    expect(await store.getOAuthEntry("acme")).toBeUndefined();
    expect(await store.getOAuthEntry("other")).toBeDefined();
    expect(await store.credentialStatus("acme")).toHaveProperty("apiKey");
    const shown = text(ui);
    expect(shown).toMatch(/signed out/i);
    expect(shown).not.toContain(ACCESS);
    expect(shown).not.toContain(REFRESH);
    // The credentials file keeps its permissions.
    expect(await readdir(root)).toContain("credentials.json");
    expect(
      JSON.parse(await readFile(join(root, "credentials.json"), "utf8")).oauth.acme,
    ).toBeUndefined();
  });

  it("says so when there is nothing to sign out of", async () => {
    const { store } = await newStore();
    const ui = fakeUi({});
    expect(await signOut({ store, profile: "acme", ui })).toBe(false);
    expect(text(ui)).toMatch(/not signed in/i);
  });
});

describe("errors the TUI prints are redacted (P-03)", () => {
  it("removes JWTs and known secrets from a probe error", () => {
    registerSecret("exact-known-secret-0123456789");
    const out = describeFailure(
      new Error(`401 for ${JWT}: exact-known-secret-0123456789 and key-passed-0123456789`),
      ["key-passed-0123456789"],
    );
    expect(out).not.toContain(JWT);
    expect(out).not.toContain("exact-known-secret-0123456789");
    expect(out).not.toContain("key-passed-0123456789");
    expect(out).toContain("401");
  });

  it("describes a non-Error rejection as text", () => {
    expect(describeFailure("plain failure")).toBe("plain failure");
  });

  it("redacts the error of a plugin hook diagnostic in the stats report", () => {
    const line = hookFailureLine({
      type: "hook_failed",
      source: "acme",
      hook: "sessionEnd",
      error: `boom ${JWT}`,
    });
    expect(line).toContain("hook_failed acme sessionEnd");
    expect(line).not.toContain(JWT);
  });
});

describe("headless `alisio run` never starts a flow (OA-AC-26)", () => {
  it("only the TUI conductor drives sign-in flows inside the CLI package", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const base = join(import.meta.dirname, "..", "packages", "cli", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(base);
    const drivers = files.filter((file) =>
      /\b(runAuthFlow|AuthFlowRegistry|startProviderAuth)\b/.test(readFileSync(file, "utf8")),
    );
    expect(drivers.map((file) => file.slice(base.length + 1))).toEqual(["tui/connect-oauth.ts"]);
    // No headless entry point imports the TUI conductor: only the TUI app does.
    const importers = files
      .filter((file) => !file.endsWith("connect-oauth.ts"))
      .filter((file) => /connect-oauth/.test(readFileSync(file, "utf8")));
    expect(importers.map((file) => file.slice(base.length + 1))).toEqual(["tui/app.ts"]);
  });
});
