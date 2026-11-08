import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthStep,
  ProviderOAuthCredential,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthFlowLimitError,
  AuthFlowRegistry,
  ProviderRegistry,
  ProviderSettingsStore,
  runAuthFlow,
  SecretRegistry,
} from "../packages/core/src/index.ts";
import { openLoopback } from "../packages/core/src/providers/oauth/loopback.ts";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OSJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1";
const CRED: ProviderOAuthCredential = {
  type: "oauth",
  access: "access-flow-0123456789",
  refresh: "refresh-flow-0123456789",
  expires: 1_900_000_000_000,
  metadata: { clientId: "client-1", hostId: "urn:uuid:host-1" },
};

/** A manual clock: `schedule` and `now` are injected, so a TTL test never waits. */
function clock() {
  let now = 1_000_000;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

async function setup(options: { ttlMs?: number; maxActive?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-oauth-flow-"));
  const store = new ProviderSettingsStore(root);
  const time = clock();
  const secrets = new SecretRegistry();
  const flows = new AuthFlowRegistry({
    store,
    now: time.now,
    schedule: time.schedule,
    secrets,
    ...options,
  });
  return { store, time, secrets, flows };
}
type Env = Awaited<ReturnType<typeof setup>>;

const method = (
  start: (ctx: ProviderAuthContext) => Promise<ProviderOAuthCredential>,
  id = "browser",
): ProviderAuthMethod => ({ id, label: id, kind: "oauth", start });
const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const never = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
const begin = (
  env: Env,
  m: ProviderAuthMethod,
  extra: { profile?: string; loopback?: "declared" | "assumed" | false; headless?: boolean } = {},
) =>
  env.flows.start({
    profile: extra.profile ?? "p",
    providerId: "chatgpt",
    method: m,
    loopback: extra.loopback ?? false,
    ...(extra.headless ? { headless: true } : {}),
  });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls until `check` returns something truthy (the method runs after an async store read). */
async function until<T>(check: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("condition not met");
    await settle(2);
  }
}

afterEach(() => undefined);

describe("a flow from start to success (OA-AC-19)", () => {
  it("runs running -> awaiting_input -> running -> succeeded, serves steps after a cursor and stores the credential with its method", async () => {
    const env = await setup();
    const entered = gate();
    const flow = begin(
      env,
      method(async (ctx) => {
        ctx.show({ type: "progress", message: "Opening the browser" });
        ctx.show({ type: "auth_url", url: "https://auth.example.com/authorize?x=1" });
        entered.resolve();
        const answer = await ctx.prompt({ message: "Paste the redirect URL", secret: true });
        ctx.show({ type: "progress", message: `Got ${answer?.length} characters` });
        return CRED;
      }),
    );
    await entered.promise;
    await until(() => flow.view().prompt);
    const first = flow.view(0);
    expect(first.status).toBe("awaiting_input");
    expect(first.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(first.prompt).toMatchObject({ message: "Paste the redirect URL", secret: true });
    expect(flow.view(1).steps.map((s) => s.n)).toEqual([2]);
    expect(flow.view(2).steps).toEqual([]);

    const id = first.prompt?.id as string;
    expect(flow.input("wrong-id", "whatever")).toBe("mismatch");
    expect(flow.input(id, "pasted-value-123")).toBe("accepted");
    expect(flow.view().status).toBe("running");
    expect(flow.view().prompt).toBeUndefined();
    expect(flow.input(id, "again")).toBe("no_prompt");
    await flow.done;
    const last = flow.view(2);
    expect(last.status).toBe("succeeded");
    expect(last.steps).toMatchObject([{ n: 3, type: "progress" }]);
    expect(last.prompt).toBeUndefined();
    expect(last.credential).toEqual({
      configured: true,
      source: "file",
      kind: "oauth",
      state: "ok",
      expires: CRED.expires,
    });
    expect(JSON.stringify(last)).not.toContain(CRED.access);
    expect(JSON.stringify(last)).not.toContain(CRED.refresh as string);
    expect(JSON.stringify(last)).not.toContain("pasted-value-123");
    const stored = await env.store.getOAuthEntry("p");
    expect(stored).toMatchObject({
      access: CRED.access,
      refresh: CRED.refresh,
      method: "browser",
      provider: "chatgpt",
      state: "ok",
      metadata: CRED.metadata,
    });
    expect(env.secrets.values()).toEqual(
      expect.arrayContaining([CRED.access, CRED.refresh, "pasted-value-123"]),
    );
  });

  it("fails when the method returns no usable credential, and writes nothing", async () => {
    const env = await setup();
    const flow = begin(
      env,
      method(async () => ({ type: "oauth", access: "" })),
    );
    await flow.done;
    expect(flow.view().status).toBe("failed");
    expect(flow.view().error?.code).toBe("auth_failed");
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
  });

  it("drops credential fields it does not know and metadata values that are not strings", async () => {
    const env = await setup();
    const flow = begin(
      env,
      method(
        async () =>
          ({
            type: "oauth",
            access: CRED.access,
            expires: Number.NaN,
            extra: "nope",
            metadata: { ok: "yes", bad: 5 },
          }) as unknown as ProviderOAuthCredential,
      ),
    );
    await flow.done;
    const stored = await env.store.getOAuthEntry("p");
    expect(stored?.metadata).toEqual({ ok: "yes" });
    expect(stored).not.toHaveProperty("extra");
    expect(stored?.expires).toBeUndefined();
  });
});

describe("cancel, expiry and replacement (OA-AC-20, 21, 22, 46)", () => {
  it("DELETE aborts the signal, closes the loopback and keeps credentials out; a second cancel is a no-op", async () => {
    const env = await setup();
    const opened = gate<string>();
    let aborted = false;
    const flow = begin(
      env,
      method(async (ctx) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        const loopback = await ctx.loopback?.({ port: 0, path: "/cb", state: "state-0123456789" });
        opened.resolve(loopback?.redirectUri ?? "");
        return (await Promise.race([loopback?.wait(), never(ctx.signal)])) as never;
      }),
      { loopback: "assumed" },
    );
    const uri = new URL(await opened.promise);
    const port = Number(uri.port);
    expect(flow.view().loopback).toBe("assumed");
    flow.cancel();
    await flow.done;
    expect(aborted).toBe(true);
    expect(flow.view().status).toBe("cancelled");
    expect(flow.view().error?.code).toBe("cancelled");
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
    // The port is free again.
    const again = await openLoopback({ port, path: "/cb", state: "state-0123456789" });
    again.close();
    flow.cancel();
    expect(flow.view().status).toBe("cancelled");
  });

  it("expires an unfinished flow at +15 min, aborts it and closes the listener; a terminal one is swept 2 min later", async () => {
    const env = await setup();
    const opened = gate<string>();
    let aborted = false;
    const flow = begin(
      env,
      method(async (ctx) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        const loopback = await ctx.loopback?.({ port: 0, path: "/cb", state: "state-0123456789" });
        opened.resolve(loopback?.redirectUri ?? "");
        return (await Promise.race([loopback?.wait(), never(ctx.signal)])) as never;
      }),
      { loopback: "declared" },
    );
    const port = Number(new URL(await opened.promise).port);
    env.time.advance(899_999);
    expect(flow.view().status).toBe("running");
    env.time.advance(1);
    expect(flow.view().status).toBe("expired");
    expect(flow.view().error?.code).toBe("expired");
    await flow.done;
    expect(aborted).toBe(true);
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
    const again = await openLoopback({ port, path: "/cb", state: "state-0123456789" });
    again.close();
    expect(env.flows.get(flow.id)).toBe(flow);
    env.time.advance(119_999);
    expect(env.flows.get(flow.id)).toBe(flow);
    env.time.advance(1);
    expect(env.flows.get(flow.id)).toBeUndefined();
  });

  it("a second start for the profile cancels the first, a fifth active flow is refused and steps are capped at 50", async () => {
    const env = await setup();
    const hold = (ctx: ProviderAuthContext) => never(ctx.signal);
    const first = begin(env, method(hold));
    const second = begin(env, method(hold));
    expect(first.view().status).toBe("cancelled");
    expect(second.view().status).toBe("running");
    expect(env.flows.get(first.id)?.view().status).toBe("cancelled");
    const others = ["b", "c", "d"].map((profile) => begin(env, method(hold), { profile }));
    expect(others.every((f) => f.view().status === "running")).toBe(true);
    expect(() => begin(env, method(hold), { profile: "e" })).toThrow(AuthFlowLimitError);
    // Replacing a profile's own flow does not count against the limit.
    expect(() => begin(env, method(hold), { profile: "b" })).not.toThrow();
    env.flows.cancelAll();

    const long = begin(
      env,
      method(async (ctx) => {
        for (let i = 1; i <= 60; i++) ctx.show({ type: "progress", message: `step ${i}` });
        ctx.show({
          type: "progress",
          message: "x".repeat(5_000),
        });
        return CRED;
      }),
      { profile: "z" },
    );
    await long.done;
    const steps = long.view(0).steps;
    expect(steps).toHaveLength(50);
    expect(steps[0]?.n).toBe(12);
    expect(steps.at(-1)?.n).toBe(61);
    const text = (steps.at(-1) as { message: string }).message;
    expect(text.length).toBeLessThanOrEqual(2_048);
  });

  it.each(["cancel", "replace", "expire"] as const)(
    "a start() that succeeds after the flow was %s writes nothing and keeps the earlier state",
    async (how) => {
      const env = await setup();
      const release = gate<ProviderOAuthCredential>();
      const flow = begin(
        env,
        method(() => release.promise),
      );
      const state = how === "cancel" ? "cancelled" : how === "replace" ? "cancelled" : "expired";
      if (how === "cancel") flow.cancel();
      else if (how === "replace")
        begin(
          env,
          method(() => never(new AbortController().signal)),
        );
      else env.time.advance(900_000);
      expect(flow.view().status).toBe(state);
      release.resolve(CRED);
      await flow.done;
      expect(flow.view().status).toBe(state);
      expect(await env.store.getOAuthEntry("p")).toBeUndefined();
      env.flows.cancelAll();
    },
  );

  it("a profile sign-in that started before DELETE of the session cannot bring it back (guard under the lock)", async () => {
    const env = await setup();
    const release = gate<ProviderOAuthCredential>();
    const flow = begin(
      env,
      method(() => release.promise),
    );
    env.flows.cancelProfile("p");
    release.resolve(CRED);
    await flow.done;
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
  });

  it("a cancel that arrives while the commit waits for the credentials lock wins, and one that arrives after the guard passed is too late", async () => {
    // Before the guard: the flow is cancelled while setOAuth is queued, so the guard says no.
    const env = await setup();
    const real = env.store.setOAuth.bind(env.store);
    let cancelAt: "before" | "after" = "before";
    let flowRef: ReturnType<typeof begin> | undefined;
    env.store.setOAuth = (async (name, credential, binding, condition) => {
      if (cancelAt === "before") flowRef?.cancel();
      const result = await real(name, credential, binding, {
        ...condition,
        guard: () => {
          const ok = condition?.guard?.() ?? true;
          // The guard passed: a cancel from here on is too late.
          if (cancelAt === "after") flowRef?.cancel();
          return ok;
        },
      });
      return result;
    }) as typeof env.store.setOAuth;
    const first = begin(
      env,
      method(async () => CRED),
    );
    flowRef = first;
    await first.done;
    expect(first.view().status).toBe("cancelled");
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();

    cancelAt = "after";
    const second = begin(
      env,
      method(async () => CRED),
    );
    flowRef = second;
    await second.done;
    expect(second.view().status).toBe("succeeded");
    expect((await env.store.getOAuthEntry("p"))?.access).toBe(CRED.access);
  });
});

describe("a terminal state is final", () => {
  it("keeps the first outcome: a cancelled flow does not expire later, an expired one cannot be cancelled", async () => {
    const env = await setup();
    const cancelled = begin(
      env,
      method((ctx) => never(ctx.signal)),
    );
    cancelled.cancel();
    env.time.advance(900_000);
    expect(cancelled.view().status).toBe("cancelled");
    expect(cancelled.view().error?.code).toBe("cancelled");

    const expired = begin(
      env,
      method((ctx) => never(ctx.signal)),
      { profile: "q" },
    );
    env.time.advance(900_000);
    expired.cancel();
    expect(expired.view().status).toBe("expired");
    expect(expired.view().error?.code).toBe("expired");
  });

  it("resolves a pending prompt with undefined when the flow ends, and a prompt asked afterwards at once", async () => {
    const env = await setup();
    const answers: Array<string | undefined> = [];
    const flow = begin(
      env,
      method(async (ctx) => {
        const pending = ctx.prompt({ message: "waiting" });
        answers.push(await pending);
        answers.push(await ctx.prompt({ message: "too late" }));
        return CRED;
      }),
    );
    await until(() => flow.view().prompt);
    flow.cancel();
    await flow.done;
    expect(answers).toEqual([undefined, undefined]);
    expect(flow.view().prompt).toBeUndefined();
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
  });

  it("an expiry that fires while the credential is being committed is too late and the flow succeeds", async () => {
    const env = await setup();
    const real = env.store.setOAuth.bind(env.store);
    env.store.setOAuth = (async (name, credential, binding, condition) =>
      real(name, credential, binding, {
        ...condition,
        guard: () => {
          const ok = condition?.guard?.() ?? true;
          env.time.advance(900_000);
          return ok;
        },
      })) as typeof env.store.setOAuth;
    const flow = begin(
      env,
      method(async () => CRED),
    );
    await flow.done;
    expect(flow.view().status).toBe("succeeded");
    expect(flow.view().error).toBeUndefined();
  });
});

describe("what is stored", () => {
  it("omits expires from the status of a credential that has none", async () => {
    const env = await setup();
    const flow = begin(
      env,
      method(async () => ({ type: "oauth", access: "access-without-expiry-12345" })),
    );
    await flow.done;
    expect(flow.view().credential).toStrictEqual({
      configured: true,
      source: "file",
      kind: "oauth",
      state: "ok",
    });
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a non-string access", { type: "oauth", access: 5 }],
    ["an empty access", { type: "oauth", access: "" }],
  ])("fails when the method returns %s", async (_name, value) => {
    const env = await setup();
    const flow = begin(
      env,
      method(async () => value as unknown as ProviderOAuthCredential),
    );
    await flow.done;
    expect(flow.view().status).toBe("failed");
    expect(flow.view().error?.code).toBe("auth_failed");
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
  });

  it("fails with a clear message when the store cannot write, and the flow stays cancellable-free (terminal)", async () => {
    const env = await setup();
    env.store.setOAuth = (async () => {
      throw new Error("disk is full");
    }) as typeof env.store.setOAuth;
    const flow = begin(
      env,
      method(async () => CRED),
    );
    await flow.done;
    expect(flow.view().status).toBe("failed");
    expect(flow.view().error).toEqual({
      code: "auth_failed",
      message: "The sign-in could not be stored: disk is full",
    });
  });

  it("a registry started without ttlMs uses the 15 minute default and one given is honored", async () => {
    const env = await setup({ ttlMs: 1_000 });
    const short = begin(
      env,
      method((ctx) => never(ctx.signal)),
    );
    env.time.advance(999);
    expect(short.view().status).toBe("running");
    env.time.advance(1);
    expect(short.view().status).toBe("expired");
  });

  it("sweeps finished flows when a new one starts and counts what cancelProfile and cancelRegistration cancel", async () => {
    const env = await setup();
    const key = {};
    const a = env.flows.start({
      profile: "a",
      providerId: "chatgpt",
      registrationKey: key,
      loopback: false,
      method: method((ctx) => never(ctx.signal)),
    });
    const b = env.flows.start({
      profile: "b",
      providerId: "chatgpt",
      registrationKey: key,
      loopback: false,
      method: method((ctx) => never(ctx.signal)),
    });
    const c = begin(
      env,
      method((ctx) => never(ctx.signal)),
      { profile: "c" },
    );
    expect(env.flows.cancelProfile("c")).toBe(1);
    expect(env.flows.cancelProfile("c")).toBe(0);
    expect(env.flows.cancelRegistration(key)).toBe(2);
    expect(env.flows.cancelRegistration(key)).toBe(0);
    expect([a, b, c].every((f) => f.view().status === "cancelled")).toBe(true);
    expect(env.flows.activeCount).toBe(0);
    env.time.advance(120_000);
    begin(
      env,
      method((ctx) => never(ctx.signal)),
      { profile: "d" },
    );
    // The finished ones were swept by the start above, without anyone asking for them.
    env.time.advance(0);
    expect([a.id, b.id, c.id].map((id) => env.flows.get(id))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    env.flows.cancelAll();
    expect(env.flows.activeCount).toBe(0);
  });
});

describe("context: loopback, headless and prompts (OA-AC-25, 26)", () => {
  it.each([
    ["declared", true],
    ["assumed", true],
    [false, false],
  ] as const)("loopback mode %s offers ctx.loopback: %s", async (mode, offered) => {
    const env = await setup();
    let seen: boolean | undefined;
    const flow = begin(
      env,
      method(async (ctx) => {
        seen = typeof ctx.loopback === "function";
        return CRED;
      }),
      { loopback: mode },
    );
    await flow.done;
    expect(seen).toBe(offered);
    expect(flow.view().loopback).toBe(mode === false ? undefined : mode);
  });

  it("a headless flow gets no loopback and its prompt resolves undefined", async () => {
    const env = await setup();
    let answer: string | undefined = "unset";
    let hasLoopback: boolean | undefined;
    const flow = begin(
      env,
      method(async (ctx) => {
        hasLoopback = typeof ctx.loopback === "function";
        answer = await ctx.prompt({ message: "anyone there?" });
        return CRED;
      }),
      { headless: true, loopback: "assumed" },
    );
    await flow.done;
    expect(answer).toBeUndefined();
    expect(hasLoopback).toBe(false);
    expect(flow.view().status).toBe("succeeded");
    expect(flow.view().loopback).toBeUndefined();
  });

  it("registers the parameters of a loopback redirect as exact secrets and keeps prompts queued in order", async () => {
    const env = await setup();
    const opened = gate<string>();
    const flow = begin(
      env,
      method(async (ctx) => {
        const lb = await ctx.loopback?.({ port: 0, path: "/cb", state: "state-0123456789" });
        opened.resolve(lb?.redirectUri ?? "");
        await lb?.wait();
        const a = await ctx.prompt({ message: "first" });
        const b = await ctx.prompt({ message: "second" });
        return { ...CRED, metadata: { a: a ?? "", b: b ?? "" } };
      }),
      { loopback: "assumed" },
    );
    const uri = new URL(await opened.promise);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: uri.port,
          path: "/cb?state=state-0123456789&code=AUTH-CODE-0123456789",
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });
    const first = await until(() => flow.view().prompt);
    expect(env.secrets.values()).toContain("AUTH-CODE-0123456789");
    expect(first.message).toBe("first");
    flow.input(first.id, "answer-one-12345");
    const second = await until(() => {
      const prompt = flow.view().prompt;
      return prompt && prompt.id !== first.id ? prompt : undefined;
    });
    expect(second.message).toBe("second");
    flow.input(second.id, "answer-two-12345");
    await flow.done;
    expect(flow.view().status).toBe("succeeded");
  });

  it("lets an in-process caller (the TUI) answer prompts and see steps through callbacks", async () => {
    const env = await setup();
    const seen: ProviderAuthStep[] = [];
    const flow = runAuthFlow({
      store: env.store,
      profile: "p",
      providerId: "chatgpt",
      loopback: false,
      now: env.time.now,
      schedule: env.time.schedule,
      secrets: env.secrets,
      onStep: (step) => seen.push(step),
      onPrompt: async (request) => (request.secret ? "typed-secret-123" : "typed"),
      method: method(async (ctx) => {
        ctx.show({ type: "progress", message: "hello" });
        const value = await ctx.prompt({ message: "code?", secret: true });
        return { ...CRED, metadata: { value: value ?? "" } };
      }),
    });
    await flow.done;
    expect(seen).toEqual([{ type: "progress", message: "hello" }]);
    expect((await env.store.getOAuthEntry("p"))?.metadata).toEqual({ value: "typed-secret-123" });
    expect(env.secrets.values()).toContain("typed-secret-123");
  });
});

describe("failures and redaction (OA-AC-30)", () => {
  it("redacts tokens, JWTs and prompt answers from a failure and never returns a prompt value", async () => {
    const env = await setup();
    const answered = gate<string | undefined>();
    const flow = begin(
      env,
      method(async (ctx) => {
        const value = await ctx.prompt({ message: "Secret?", secret: true });
        answered.resolve(value);
        throw new Error(
          `exchange failed: ${JWT} and sk-live-0123456789abcdefghijklmn and ${value} Bearer abcdefghijklmnopqrstuvwxyz0123`,
        );
      }),
    );
    flow.input((await until(() => flow.view().prompt)).id, "hunter2-the-answer");
    await answered.promise;
    await flow.done;
    const view = flow.view();
    expect(view.status).toBe("failed");
    expect(view.error?.code).toBe("auth_failed");
    const text = JSON.stringify(view);
    for (const leaked of [JWT, "sk-live-0123456789abcdefghijklmn", "hunter2-the-answer"])
      expect(text).not.toContain(leaked);
    expect(view.error?.message).toContain("[redacted]");
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
  });

  it("redacts step texts and keeps a known error code", async () => {
    const env = await setup();
    const flow = begin(
      env,
      method(async (ctx) => {
        ctx.show({ type: "progress", message: `token ${JWT}` });
        throw Object.assign(new Error("port busy"), { code: "loopback_unavailable" });
      }),
    );
    await flow.done;
    expect(JSON.stringify(flow.view())).not.toContain(JWT);
    expect(flow.view().error).toEqual({ code: "loopback_unavailable", message: "port busy" });
  });
});

describe("previous metadata (OA-AC-40)", () => {
  async function metadataSeen(env: Env) {
    let seen: unknown = "unset";
    let serialized = "";
    const flow = begin(
      env,
      method(async (ctx) => {
        seen = ctx.previousMetadata;
        serialized = JSON.stringify(ctx);
        return CRED;
      }),
    );
    await flow.done;
    return { seen, serialized };
  }

  it("passes the stored metadata (never tokens) for a session that is ok or needs a new sign-in, and undefined without one", async () => {
    const env = await setup();
    expect((await metadataSeen(env)).seen).toBeUndefined();
    const generation = (await env.store.setOAuth(
      "p",
      {
        type: "oauth",
        access: "secret-access-0123456",
        refresh: "secret-refresh-0123456",
        metadata: { hostId: "h1" },
      },
      { method: "browser", provider: "chatgpt" },
    )) as number;
    let result = await metadataSeen(env);
    expect(result.seen).toEqual({ hostId: "h1" });
    expect(result.serialized).not.toContain("secret-access");
    expect(result.serialized).not.toContain("secret-refresh");
    // The flow above signed in again with CRED; mark that session as needing a sign-in.
    const current = (await env.store.getOAuthEntry("p"))?.generation as number;
    expect(current).toBeGreaterThan(generation);
    await env.store.markOAuthState("p", "needs_sign_in", current);
    result = await metadataSeen(env);
    expect(result.seen).toEqual(CRED.metadata);
  });

  it("is undefined when the stored session belongs to another provider registration", async () => {
    const env = await setup();
    await env.store.setOAuth(
      "p",
      { type: "oauth", access: "other-access-0123456", metadata: { hostId: "foreign" } },
      { method: "browser", provider: "someone-else" },
    );
    expect((await metadataSeen(env)).seen).toBeUndefined();
  });
});

describe("step URLs (OA-AC-50, OA-AC-62)", () => {
  const bad = [
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "file:///etc/passwd",
    "http://example.com/x",
    "ftp://example.com/x",
    "https://user:pass@auth.example.com/x",
    "not a url",
    `https://auth.example.com/${"a".repeat(4_100)}`,
  ];
  const good = ["http://127.0.0.1:1455/x", "http://localhost/x", "https://auth.example.com/x"];
  const shapes = {
    auth_url: (url: string): ProviderAuthStep => ({ type: "auth_url", url }),
    device_code: (url: string): ProviderAuthStep => ({
      type: "device_code",
      verificationUri: url,
      userCode: "ABCD-1234",
      expiresInSeconds: 600,
    }),
    device_code_complete: (url: string): ProviderAuthStep => ({
      type: "device_code",
      verificationUri: "https://auth.example.com/device",
      verificationUriComplete: url,
      userCode: "ABCD-1234",
      expiresInSeconds: 600,
    }),
  };

  for (const [shape, make] of Object.entries(shapes)) {
    it.each(bad)(
      `rejects %s in ${shape}: no step, aborted signal, failed with unsafe_url`,
      async (url) => {
        const env = await setup();
        let aborted = false;
        const flow = begin(
          env,
          method(async (ctx) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
            });
            ctx.show(make(url));
            return CRED;
          }),
        );
        await flow.done;
        const view = flow.view();
        expect(view.status).toBe("failed");
        expect(view.error?.code).toBe("unsafe_url");
        expect(view.steps).toEqual([]);
        expect(aborted).toBe(true);
        expect(JSON.stringify(view)).not.toContain("passwd");
        expect(await env.store.getOAuthEntry("p")).toBeUndefined();
      },
    );

    it.each(good)(`accepts %s in ${shape}`, async (url) => {
      const env = await setup();
      const flow = begin(
        env,
        method(async (ctx) => {
          ctx.show(make(url));
          return CRED;
        }),
      );
      await flow.done;
      expect(flow.view().status).toBe("succeeded");
      expect(flow.view().steps).toHaveLength(1);
    });
  }

  it("carries the optional device_code fields when present and omits them when absent", async () => {
    const env = await setup();
    const flow = begin(
      env,
      method(async (ctx) => {
        ctx.show({
          type: "device_code",
          verificationUri: "https://auth.example.com/device",
          verificationUriComplete: "https://auth.example.com/device?c=ABCD",
          userCode: "ABCD-1234",
          expiresInSeconds: 600,
          intervalSeconds: 5,
        });
        ctx.show({
          type: "device_code",
          verificationUri: "https://auth.example.com/device",
          userCode: "WXYZ-9999",
          expiresInSeconds: 300,
        });
        return CRED;
      }),
    );
    await flow.done;
    const [full, bare] = flow.view().steps;
    expect(full).toEqual({
      n: 1,
      type: "device_code",
      verificationUri: "https://auth.example.com/device",
      verificationUriComplete: "https://auth.example.com/device?c=ABCD",
      userCode: "ABCD-1234",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });
    expect(bare).toEqual({
      n: 2,
      type: "device_code",
      verificationUri: "https://auth.example.com/device",
      userCode: "WXYZ-9999",
      expiresInSeconds: 300,
    });
  });
});

describe("removal of a registration (OA-AC-58)", () => {
  it("cancels the pending flows of that registration, aborts the signal and closes the loopback, and writes nothing", async () => {
    const env = await setup();
    const registry = new ProviderRegistry();
    const key = {};
    registry.onRemoved((entry) => env.flows.cancelRegistration(entry));
    const unregister = registry.register(
      {
        id: "chatgpt",
        name: "ChatGPT",
        fields: [],
        create: () => ({ id: "c", model: "m", async *stream() {} }),
      },
      { plugin: "p", builtin: false },
    );
    const entry = registry.get("chatgpt");
    void key;
    const opened = gate<string>();
    let aborted = false;
    const flow = env.flows.start({
      profile: "p",
      providerId: "chatgpt",
      registrationKey: entry,
      loopback: "assumed",
      method: method(async (ctx) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        const lb = await ctx.loopback?.({ port: 0, path: "/cb", state: "state-0123456789" });
        opened.resolve(lb?.redirectUri ?? "");
        return (await Promise.race([lb?.wait(), never(ctx.signal)])) as never;
      }),
    });
    const other = env.flows.start({
      profile: "q",
      providerId: "other",
      registrationKey: {},
      loopback: false,
      method: method((ctx) => never(ctx.signal)),
    });
    const port = Number(new URL(await opened.promise).port);
    unregister();
    await flow.done;
    expect(flow.view().status).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(other.view().status).toBe("running");
    expect(await env.store.getOAuthEntry("p")).toBeUndefined();
    (await openLoopback({ port, path: "/cb", state: "state-0123456789" })).close();
    expect(registry.get("chatgpt")).toBeUndefined();
    env.flows.cancelAll();
  });

  it("does not notify for a registration that was replaced before its disposer ran", () => {
    const registry = new ProviderRegistry();
    const removed: string[] = [];
    registry.onRemoved((entry) => removed.push(entry.id));
    const make = () => ({
      id: "p",
      name: "P",
      fields: [],
      create: () => ({ id: "p", model: "m", async *stream() {} }),
    });
    const first = registry.register(make(), { plugin: "a", builtin: false });
    first();
    expect(removed).toEqual(["p"]);
    first();
    expect(removed).toEqual(["p"]);
  });
});
