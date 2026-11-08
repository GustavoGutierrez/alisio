import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelProvider,
  ProviderAuthMethod,
  ProviderCreateRequest,
  ProviderOAuthCredential,
} from "@alisio/sdk";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  needsRefresh,
  OAuthManager,
  ProviderRegistry,
  ProviderSettingsStore,
  SecretRegistry,
} from "../packages/core/src/index.ts";

const NOW = 1_800_000_000_000;
const MARGIN = 300_000;
const cred = (extra: Partial<ProviderOAuthCredential> = {}): ProviderOAuthCredential => ({
  type: "oauth",
  access: "access-A-0123456789",
  refresh: "refresh-A-0123456789",
  expires: NOW + 3_600_000,
  ...extra,
});

type RefreshFn = (
  credential: ProviderOAuthCredential,
  signal: AbortSignal,
) => Promise<ProviderOAuthCredential>;

interface Setup {
  store: ProviderSettingsStore;
  manager: OAuthManager;
  refresh: Mock<RefreshFn>;
  clock: { now: number };
  seed(c?: ProviderOAuthCredential, profile?: string): Promise<number>;
  setMethod(method: Partial<ProviderAuthMethod> | undefined): void;
  registrations: Map<string, { auth?: ProviderAuthMethod[] }>;
  secrets: SecretRegistry;
}

async function setup(
  options: {
    refresh?: (c: ProviderOAuthCredential, s: AbortSignal) => Promise<ProviderOAuthCredential>;
    refreshTimeoutMs?: number;
  } = {},
): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "alisio-oauth-mgr-"));
  const store = new ProviderSettingsStore(root);
  const clock = { now: NOW };
  let counter = 0;
  const refresh = vi.fn<RefreshFn>(
    options.refresh ??
      (async (c: ProviderOAuthCredential) => ({
        ...c,
        access: `access-N${++counter}-0123456789`,
        refresh: `refresh-N${counter}-0123456789`,
        expires: clock.now + 3_600_000,
      })),
  );
  const method: ProviderAuthMethod = {
    id: "browser",
    label: "Browser",
    kind: "oauth",
    start: async () => cred(),
    refresh,
  };
  const registrations = new Map<string, { auth?: ProviderAuthMethod[] }>([
    ["chatgpt", { auth: [method] }],
  ]);
  const secrets = new SecretRegistry();
  const manager = new OAuthManager({
    store,
    registry: { get: (id) => registrations.get(id) },
    now: () => clock.now,
    secrets,
    ...(options.refreshTimeoutMs ? { refreshTimeoutMs: options.refreshTimeoutMs } : {}),
  });
  return {
    store,
    manager,
    refresh,
    clock,
    registrations,
    secrets,
    seed: async (c = cred(), profile = "p") =>
      (await store.setOAuth(profile, c, { method: "browser", provider: "chatgpt" })) as number,
    setMethod: (patch) =>
      registrations.set("chatgpt", {
        auth: patch ? [{ ...method, ...patch }] : [],
      }),
  };
}
const get = (s: Setup, signal?: AbortSignal) => s.manager.get("p", "chatgpt", signal);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

afterEach(() => vi.useRealTimers());

describe("needsRefresh (OA-AC-09, OA-AC-42)", () => {
  it("renews at expires - now <= 300 000 ms, not above; a token without expires only after a rejection", () => {
    const at = (left: number) => ({ access: "a", expires: NOW + left });
    expect(needsRefresh(at(301_000), NOW, MARGIN)).toBe(false);
    expect(needsRefresh(at(300_000), NOW, MARGIN)).toBe(true);
    expect(needsRefresh(at(0), NOW, MARGIN)).toBe(true);
    expect(needsRefresh(at(-5), NOW, MARGIN)).toBe(true);
    expect(needsRefresh({ access: "a" }, NOW, MARGIN)).toBe(false);
    expect(needsRefresh({ access: "a" }, NOW, MARGIN, "a")).toBe(true);
    expect(needsRefresh({ access: "b" }, NOW, MARGIN, "a")).toBe(false);
  });
});

describe("get() and renewal", () => {
  it("returns a valid credential without renewing or writing (OA-AC-09)", async () => {
    const s = await setup();
    await s.seed(cred({ expires: NOW + 301_000 }));
    expect((await get(s)).access).toBe("access-A-0123456789");
    expect(s.refresh).not.toHaveBeenCalled();
    expect((await s.store.getOAuthEntry("p"))?.generation).toBe(1);
  });

  it.each([300_000, 0])("renews at %i ms left (OA-AC-09)", async (left) => {
    const s = await setup();
    await s.seed(cred({ expires: NOW + left }));
    expect((await get(s)).access).toMatch(/^access-N1/);
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it("shares one renewal between 10 concurrent callers (OA-AC-07)", async () => {
    const gate = deferred<ProviderOAuthCredential>();
    const s = await setup({ refresh: () => gate.promise });
    await s.seed(cred({ expires: NOW - 1 }));
    const calls = Array.from({ length: 10 }, () => get(s));
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalledTimes(1));
    gate.resolve(cred({ access: "access-NEW-0123456789", expires: NOW + 3_600_000 }));
    const results = await Promise.all(calls);
    expect(new Set(results.map((r) => r.access))).toEqual(new Set(["access-NEW-0123456789"]));
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it("persists the rotated refresh token before returning it (OA-AC-12)", async () => {
    const s = await setup();
    await s.seed(cred({ expires: NOW - 1 }));
    const result = await get(s);
    const stored = await s.store.getOAuthEntry("p");
    expect(stored?.access).toBe(result.access);
    expect(stored?.refresh).toBe("refresh-N1-0123456789");
    expect(stored?.state).toBe("ok");
  });

  it("merges refresh() metadata over the stored one and keeps the refresh token it did not repeat (OA-AC-39)", async () => {
    const s = await setup({
      refresh: async () => ({
        type: "oauth",
        access: "access-N-0123456789",
        expires: NOW + 3_600_000,
        metadata: { extra: "new", clientId: "replaced" },
      }),
    });
    await s.seed(
      cred({ expires: NOW - 1, metadata: { clientId: "c1", hostId: "urn:uuid:h", other: "x" } }),
    );
    await get(s);
    const stored = await s.store.getOAuthEntry("p");
    expect(stored?.metadata).toEqual({
      clientId: "replaced",
      hostId: "urn:uuid:h",
      other: "x",
      extra: "new",
    });
    expect(stored?.refresh).toBe("refresh-A-0123456789");

    const none = await setup({
      refresh: async () => ({
        type: "oauth",
        access: "access-M-0123456789",
        expires: NOW + 3_600_000,
      }),
    });
    await none.seed(cred({ expires: NOW - 1, metadata: { clientId: "c1", hostId: "h" } }));
    await get(none);
    expect((await none.store.getOAuthEntry("p"))?.metadata).toEqual({
      clientId: "c1",
      hostId: "h",
    });
  });

  it("still renews when earliestRefreshAt is in the future and keeps it in milliseconds (OA-AC-42)", async () => {
    const future = String(NOW + 7_200_000);
    for (const expires of [NOW + 300_000, NOW - 10_000]) {
      const s = await setup({
        refresh: async (c) => ({ ...c, access: "access-N-0123456789", expires: NOW + 3_600_000 }),
      });
      await s.seed(cred({ expires, metadata: { earliestRefreshAt: future } }));
      await get(s);
      expect(s.refresh).toHaveBeenCalledTimes(1);
      expect((await s.store.getOAuthEntry("p"))?.metadata?.earliestRefreshAt).toBe(future);
    }
  });

  it("needs_sign_in on a permanent failure, keeps the credential and ignores the environment (OA-AC-10)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env-should-never-be-used-0123456789");
    try {
      const s = await setup({
        refresh: async () => {
          throw new Error("400 invalid_grant");
        },
      });
      await s.seed(cred({ expires: NOW - 1 }));
      await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
      const stored = await s.store.getOAuthEntry("p");
      expect(stored).toMatchObject({
        state: "needs_sign_in",
        access: "access-A-0123456789",
        refresh: "refresh-A-0123456789",
      });
      s.refresh.mockClear();
      await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
      expect(s.refresh).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a retryable failure keeps the state and only fails that call (OA-AC-11)", async () => {
    let fail = true;
    const s = await setup({
      refresh: async (c) => {
        if (fail) throw Object.assign(new Error("network down"), { retryable: true });
        return { ...c, access: "access-OK-0123456789", expires: NOW + 3_600_000 };
      },
    });
    await s.seed(cred({ expires: NOW - 1 }));
    await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_REFRESH_FAILED", retryable: true });
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("ok");
    fail = false;
    expect((await get(s)).access).toBe("access-OK-0123456789");
  });

  it("no refresh function or no refresh token means needs_sign_in once it is due", async () => {
    const s = await setup();
    s.setMethod({ refresh: undefined });
    await s.seed(cred({ expires: NOW - 1 }));
    await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("needs_sign_in");

    const t = await setup();
    await t.seed({ type: "oauth", access: "access-X-0123456789", expires: NOW - 1 });
    await expect(get(t)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    expect(t.refresh).not.toHaveBeenCalled();
  });

  it("a hanging plugin ends at the renewal's own time limit, transiently (OA-AC-47)", async () => {
    let seen: AbortSignal | undefined;
    const s = await setup({
      refreshTimeoutMs: 40,
      refresh: (_c, signal) => {
        seen = signal;
        return new Promise(() => {});
      },
    });
    await s.seed(cred({ expires: NOW - 1 }));
    await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_REFRESH_FAILED", retryable: true });
    expect(seen?.aborted).toBe(true);
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("ok");
  });

  it("aborting caller 1 rejects only its own get(); callers 2 and 3 get the token; refresh runs once (OA-AC-47)", async () => {
    const gate = deferred<ProviderOAuthCredential>();
    let refreshSignal: AbortSignal | undefined;
    const s = await setup({
      refresh: (_c, signal) => {
        refreshSignal = signal;
        return gate.promise;
      },
    });
    await s.seed(cred({ expires: NOW - 1 }));
    const controller = new AbortController();
    const first = get(s, controller.signal);
    const second = get(s);
    const third = get(s);
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalledTimes(1));
    controller.abort(new Error("caller gave up"));
    await expect(first).rejects.toThrow("caller gave up");
    expect(refreshSignal?.aborted).toBe(false);
    gate.resolve(cred({ access: "access-NEW-0123456789", expires: NOW + 3_600_000 }));
    expect((await second).access).toBe("access-NEW-0123456789");
    expect((await third).access).toBe("access-NEW-0123456789");
    expect(s.refresh).toHaveBeenCalledTimes(1);
    await expect(get(s, AbortSignal.abort(new Error("late")))).rejects.toThrow("late");
  });

  it("waiting for the refresh lock is transient and leaves the session alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-oauth-busy-"));
    const store = new ProviderSettingsStore(root);
    await store.setOAuth("p", cred({ expires: NOW - 1 }), {
      method: "browser",
      provider: "chatgpt",
    });
    await writeFile(store.refreshLockPath, "someone-renewing");
    let clock = 0;
    const manager = new OAuthManager({
      store,
      now: () => NOW,
      registry: {
        get: () => ({
          auth: [{ id: "browser", label: "b", kind: "oauth", start: async () => cred() }],
        }),
      },
      refreshLockTiming: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        random: () => 0,
      },
      secrets: new SecretRegistry(),
    });
    await expect(manager.get("p", "chatgpt")).rejects.toMatchObject({
      code: "OAUTH_REFRESH_BUSY",
      retryable: true,
    });
    expect(clock).toBeGreaterThanOrEqual(20_000);
    expect((await store.getOAuthEntry("p"))?.state).toBe("ok");
  });
});

describe("what the plugin sees and the manager records", () => {
  it("returns exactly the stored fields, without absent keys", async () => {
    const s = await setup();
    await s.seed({ type: "oauth", access: "access-ONLY-0123456789" });
    expect(Object.keys(await get(s)).sort()).toEqual(["access", "type"]);
    const t = await setup({
      refresh: async () => ({ type: "oauth", access: "access-NEXT-0123456789" }),
    });
    await t.seed(cred({ expires: NOW - 1, refresh: undefined, metadata: undefined }));
    // No refresh token to renew with: sign-in is needed; with one, the result has only what was returned.
    await expect(get(t)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    const u = await setup({
      refresh: async () => ({ type: "oauth", access: "access-NEXT-0123456789" }),
    });
    await u.seed(cred({ expires: NOW - 1 }));
    const renewed = await get(u);
    expect(Object.keys(renewed).sort()).toEqual(["access", "refresh", "type"]);
    expect(renewed.refresh).toBe("refresh-A-0123456789");
  });

  it("uses the refresh function of the stored method when the registration has several", async () => {
    const s = await setup();
    const other = vi.fn<RefreshFn>();
    s.registrations.set("chatgpt", {
      auth: [
        { id: "device", label: "d", kind: "oauth", start: async () => cred(), refresh: other },
        { id: "browser", label: "b", kind: "oauth", start: async () => cred(), refresh: s.refresh },
      ],
    });
    await s.seed(cred({ expires: NOW - 1 }));
    await get(s);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("treats a stored method that left the registration as absent even when the token is valid, without marking it", async () => {
    const s = await setup();
    await s.seed(cred({ expires: NOW + 3_600_000 }));
    s.setMethod({ id: "device" });
    const failure = await get(s).catch((error) => error);
    expect(failure).toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED", retryable: false });
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("ok");
    s.registrations.set("chatgpt", {});
    await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
  });

  it("serves a valid token without touching the refresh lock", async () => {
    const s = await setup();
    await s.seed(cred({ expires: NOW + 3_600_000 }));
    await writeFile(s.store.refreshLockPath, "someone-renewing");
    expect((await get(s)).access).toBe("access-A-0123456789");
  });

  it("one transient failure is shared by concurrent callers instead of retried by each", async () => {
    const s = await setup({
      refresh: async () => {
        throw Object.assign(new Error("network down"), { retryable: true });
      },
    });
    await s.seed(cred({ expires: NOW - 1 }));
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => get(s)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts no timer that outlives the renewal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = await setup();
    await s.seed(cred({ expires: NOW - 1 }));
    await get(s);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records the token a plugin returned even when a newer sign-in made the manager drop it", async () => {
    const gate = deferred<ProviderOAuthCredential>();
    const s = await setup({ refresh: () => gate.promise });
    await s.seed(cred({ expires: NOW - 1 }));
    const call = get(s);
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalled());
    await s.seed(cred({ access: "access-NEWER-0123456789", expires: NOW + 3_600_000 }));
    gate.resolve(cred({ access: "access-LATE-0123456789", expires: NOW + 3_600_000 }));
    await call;
    expect(s.secrets.values()).toContain("access-LATE-0123456789");
  });

  it("also records the sessions it only meets in the store (another process), and when invalidating", async () => {
    const s = await setup();
    await s.seed(cred({ access: "access-OTHERPROC-0123456789" }), "someone-else");
    expect(await s.manager.exactSecrets()).toContain("access-OTHERPROC-0123456789");
    expect(await s.manager.exactSecrets()).toContain("refresh-A-0123456789");
    const t = await setup();
    await t.seed(cred({ access: "access-SEEN-ON-INVALIDATE-01" }));
    await t.manager.invalidate("p", "chatgpt");
    expect(t.secrets.values()).toContain("access-SEEN-ON-INVALIDATE-01");
  });
});

describe("invalidate (OA-AC-09, OA-AC-41, OA-AC-52, OA-AC-53)", () => {
  it("without a reason, the next get() renews and the state stays ok", async () => {
    const s = await setup();
    await s.seed(cred({ expires: NOW + 3_600_000 }));
    const handle = s.manager.handleFor("p", "chatgpt");
    expect((await handle.get()).access).toBe("access-A-0123456789");
    await handle.invalidate();
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("ok");
    expect((await handle.get()).access).toMatch(/^access-N1/);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    // The rejected value is gone: no further renewal.
    await handle.get();
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it("a token without expires and no refresh function goes to needs_sign_in after invalidate()", async () => {
    const s = await setup();
    s.setMethod({ refresh: undefined });
    await s.seed({ type: "oauth", access: "access-Z-0123456789", refresh: "r-0123456789" });
    const handle = s.manager.handleFor("p", "chatgpt");
    expect((await handle.get()).access).toBe("access-Z-0123456789");
    await handle.invalidate();
    await expect(handle.get()).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("needs_sign_in");
  });

  it.each(["sign_in_required", "valor-futuro"])(
    "invalidate(%j) marks needs_sign_in at once, keeps the credential and never refreshes",
    async (reason) => {
      vi.stubEnv("OPENAI_API_KEY", "sk-env-should-never-be-used-0123456789");
      try {
        const s = await setup();
        await s.seed();
        const handle = s.manager.handleFor("p", "chatgpt");
        await handle.invalidate(reason as "sign_in_required");
        const stored = await s.store.getOAuthEntry("p");
        expect(stored).toMatchObject({
          state: "needs_sign_in",
          access: "access-A-0123456789",
          refresh: "refresh-A-0123456789",
        });
        await expect(handle.get()).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
        expect(s.refresh).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("renews when the store still holds the rejected access (OA-AC-52a)", async () => {
    const s = await setup();
    await s.seed();
    const handle = s.manager.handleFor("p", "chatgpt");
    await handle.invalidate();
    await handle.get();
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not renew when another process already stored a different access (OA-AC-52b)", async () => {
    const s = await setup();
    await s.seed();
    const handle = s.manager.handleFor("p", "chatgpt");
    await handle.invalidate();
    await s.store.setOAuth(
      "p",
      cred({ access: "access-B-0123456789", refresh: "refresh-B-0123456789" }),
      { method: "browser", provider: "chatgpt" },
    );
    expect((await handle.get()).access).toBe("access-B-0123456789");
    expect(s.refresh).not.toHaveBeenCalled();
  });
});

describe("create() once, get() per request (OA-AC-13)", () => {
  it("a handle given at create() time yields the renewed token after expiry and after invalidate()", async () => {
    const s = await setup();
    await s.seed(cred({ expires: NOW + 3_600_000 }));
    const handle = s.manager.handleFor("p", "chatgpt");
    const first = await handle.get();
    s.clock.now = NOW + 3_600_000 - 1000; // inside the margin
    const second = await handle.get();
    expect(second.access).not.toBe(first.access);
    s.clock.now = NOW; // well before the new expiry
    await handle.invalidate();
    const third = await handle.get();
    expect(third.access).not.toBe(second.access);
    expect(s.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("binding to the registration (OA-AC-43, OA-AC-59)", () => {
  it("treats a session created by another registration as absent and passes nothing to this one (OA-AC-43)", async () => {
    const s = await setup();
    const otherRefresh = vi.fn<RefreshFn>();
    s.registrations.set("other", {
      auth: [
        {
          id: "browser",
          label: "b",
          kind: "oauth",
          start: async () => cred(),
          refresh: otherRefresh,
        },
      ],
    });
    await s.seed(cred({ expires: NOW - 1 }));
    await expect(s.manager.get("p", "other")).rejects.toMatchObject({
      code: "OAUTH_SIGN_IN_REQUIRED",
    });
    expect(otherRefresh).not.toHaveBeenCalled();
    expect(s.refresh).not.toHaveBeenCalled();
    await s.manager.invalidate("p", "other", "sign_in_required");
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("ok");
  });

  it("rejects when the provider has no registration or the stored method is gone (OA-AC-59)", async () => {
    const s = await setup();
    await s.seed(cred({ expires: NOW - 1 }));
    await expect(s.manager.get("p", "unregistered")).rejects.toMatchObject({
      code: "OAUTH_SIGN_IN_REQUIRED",
    });
    s.registrations.delete("chatgpt");
    await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    s.setMethod({ id: "device" });
    s.registrations.set("chatgpt", {
      auth: [
        { id: "device", label: "d", kind: "oauth", start: async () => cred(), refresh: s.refresh },
      ],
    });
    await expect(get(s)).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    expect(s.refresh).not.toHaveBeenCalled();
  });

  it("the error names the profile and the action, never a token", async () => {
    const s = await setup();
    const failure = await s.manager.get("nobody", "chatgpt").catch((error) => error);
    expect(failure.message).toContain('"nobody"');
    expect(failure.message).toMatch(/Settings > Models or \/connect/);
  });
});

describe("conditional writes after a wait (OA-AC-45)", () => {
  it("does not resurrect a session deleted while the renewal ran (a)", async () => {
    const gate = deferred<ProviderOAuthCredential>();
    const s = await setup({ refresh: () => gate.promise });
    await s.seed(cred({ expires: NOW - 1 }));
    const call = get(s);
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalled());
    await s.store.deleteOAuth("p");
    gate.resolve(cred({ access: "access-LATE-0123456789", expires: NOW + 3_600_000 }));
    await expect(call).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    expect(await s.store.getOAuthEntry("p")).toBeUndefined();
  });

  it("drops its result when a newer sign-in landed, and returns the current credential (b)", async () => {
    const gate = deferred<ProviderOAuthCredential>();
    const s = await setup({ refresh: () => gate.promise });
    await s.seed(cred({ expires: NOW - 1 }));
    const call = get(s);
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalled());
    await s.seed(cred({ access: "access-NEWER-0123456789", expires: NOW + 3_600_000 }));
    gate.resolve(cred({ access: "access-LATE-0123456789", expires: NOW + 3_600_000 }));
    expect((await call).access).toBe("access-NEWER-0123456789");
    expect((await s.store.getOAuthEntry("p"))?.access).toBe("access-NEWER-0123456789");
    expect((await s.store.getOAuthEntry("p"))?.generation).toBe(2);
  });

  it("a permanent failure does not mark a session that was replaced meanwhile", async () => {
    const gate = deferred<ProviderOAuthCredential>();
    const s = await setup({ refresh: () => gate.promise });
    await s.seed(cred({ expires: NOW - 1 }));
    const call = get(s);
    await vi.waitFor(() => expect(s.refresh).toHaveBeenCalled());
    await s.seed(cred({ access: "access-NEWER-0123456789", expires: NOW + 3_600_000 }));
    gate.reject(new Error("invalid_grant"));
    await expect(call).rejects.toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    expect((await s.store.getOAuthEntry("p"))?.state).toBe("ok");
  });
});

describe("handles come from the registry's one create() point (OA-AC-14)", () => {
  const stub = (id: string): ModelProvider => ({ id, model: "m", async *stream() {} });
  async function registry() {
    const s = await setup();
    const reg = new ProviderRegistry();
    const seen: ProviderCreateRequest[] = [];
    reg.register(
      {
        id: "chatgpt",
        name: "ChatGPT",
        fields: [],
        auth: [
          {
            id: "browser",
            label: "b",
            kind: "oauth",
            start: async () => cred(),
            refresh: s.refresh,
          },
        ],
        create: (request) => (seen.push(request), stub("chatgpt")),
      },
      { plugin: "t", builtin: false },
    );
    reg.register(
      {
        id: "plain",
        name: "Plain",
        fields: [],
        create: (request) => (seen.push(request), stub("plain")),
      },
      { plugin: "t", builtin: false },
    );
    reg.attachOAuth(
      new OAuthManager({
        store: s.store,
        registry: reg,
        now: () => NOW,
        secrets: new SecretRegistry(),
      }),
    );
    return { s, reg, seen };
  }

  it("only a registration that declares auth receives request.oauth, and callers cannot inject one", async () => {
    const { reg, seen } = await registry();
    const forged = { get: async () => cred(), invalidate: async () => {} };
    await reg.create("plain", { profile: {}, credentials: {}, oauth: forged }, "p");
    await reg.create("chatgpt", { profile: {}, credentials: {} }, "p");
    await reg.create("chatgpt", { profile: {}, credentials: {}, oauth: forged });
    expect(seen[0]?.oauth).toBeUndefined();
    expect(seen[1]?.oauth).toBeDefined();
    expect(seen[1]?.oauth).not.toBe(forged);
    expect(seen[2]?.oauth).toBeUndefined(); // no profile name: no handle
  });

  it("a profile's handle never returns another profile's token", async () => {
    const { s, reg, seen } = await registry();
    await s.seed(cred({ access: "access-ONE-0123456789" }), "one");
    await s.seed(cred({ access: "access-TWO-0123456789" }), "two");
    await reg.create("chatgpt", { profile: {}, credentials: {} }, "one");
    await reg.create("chatgpt", { profile: {}, credentials: {} }, "two");
    expect((await seen[0]?.oauth?.get())?.access).toBe("access-ONE-0123456789");
    expect((await seen[1]?.oauth?.get())?.access).toBe("access-TWO-0123456789");
  });
});

describe("headless use of a stored session (OA-AC-27)", () => {
  it("serves a valid session, renews an expired one and, with none, says where to sign in without any token", async () => {
    const valid = await setup();
    await valid.seed(cred({ expires: NOW + 3_600_000 }));
    expect((await get(valid)).access).toBe("access-A-0123456789");
    expect(valid.refresh).not.toHaveBeenCalled();

    const expired = await setup();
    await expired.seed(cred({ expires: NOW - 1 }));
    expect((await get(expired)).access).toMatch(/^access-N1/);

    const none = await setup();
    const failure = await get(none).catch((error: Error) => error);
    expect(failure).toMatchObject({ code: "OAUTH_SIGN_IN_REQUIRED" });
    expect((failure as Error).message).toMatch(/Settings > Models or \/connect/);
    expect((failure as Error).message).not.toMatch(/access-|refresh-/);
    expect(none.refresh).not.toHaveBeenCalled();
  });
});
