import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOAuthCredential } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ProviderSettingsStore } from "../packages/core/src/index.ts";

const cred = (access = "access-token-0001", extra: Partial<ProviderOAuthCredential> = {}) => ({
  type: "oauth" as const,
  access,
  refresh: "refresh-token-0001",
  expires: 1_700_000_000_000,
  ...extra,
});
const binding = { method: "browser", provider: "chatgpt" };
const profile = (provider = "chatgpt") => ({ provider, values: {}, model: "m" });

async function fresh() {
  const root = await mkdtemp(join(tmpdir(), "alisio-oauth-store-"));
  return { root, store: new ProviderSettingsStore(root) };
}
const raw = async (store: ProviderSettingsStore) =>
  JSON.parse(await readFile(store.credentialsPath, "utf8"));

describe("characterization: unknown top-level keys survive the existing writers (OA-AC-03)", () => {
  it("keeps an unknown key through saveActive, setCredentials and deleteCredentials", async () => {
    const { store } = await fresh();
    await writeFile(
      store.credentialsPath,
      JSON.stringify({ schemaVersion: 1, providers: { a: { apiKey: "k" } }, future: { x: 1 } }),
    );
    await store.setCredentials("a", { bearerToken: "t" });
    expect((await raw(store)).future).toEqual({ x: 1 });
    await store.saveActive("b", profile("openai"), { apiKey: "k2" });
    expect((await raw(store)).future).toEqual({ x: 1 });
    expect(await store.deleteCredentials("a")).toBe(true);
    expect((await raw(store)).future).toEqual({ x: 1 });
  });
});

describe("oauth storage (OA-AC-02..04)", () => {
  it("stores oauth[profile] with method, provider, state and generation, 0600, atomically (OA-AC-02)", async () => {
    const { root, store } = await fresh();
    await store.setCredentials("p", { apiKey: "key-keep-0123456789" });
    const generation = await store.setOAuth("p", cred(), binding);
    expect(generation).toBe(1);
    const file = await raw(store);
    expect(file.oauth.p).toMatchObject({
      type: "oauth",
      access: "access-token-0001",
      refresh: "refresh-token-0001",
      method: "browser",
      provider: "chatgpt",
      state: "ok",
      generation: 1,
    });
    expect(file.oauthSeq).toBe(1);
    expect(file.providers.p).toEqual({ apiKey: "key-keep-0123456789" });
    expect((await stat(store.credentialsPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("keeps unknown top-level keys through the oauth writers (OA-AC-03)", async () => {
    const { store } = await fresh();
    await writeFile(
      store.credentialsPath,
      JSON.stringify({ schemaVersion: 1, providers: {}, future: [1, 2] }),
    );
    const generation = await store.setOAuth("p", cred(), binding);
    expect((await raw(store)).future).toEqual([1, 2]);
    await store.markOAuthState("p", "needs_sign_in", generation as number);
    expect((await raw(store)).future).toEqual([1, 2]);
    await store.deleteOAuth("p");
    expect((await raw(store)).future).toEqual([1, 2]);
  });

  it("reads a file with oauth and no providers as providers: {} and keeps oauth (OA-AC-04)", async () => {
    const { store } = await fresh();
    await writeFile(
      store.credentialsPath,
      JSON.stringify({
        schemaVersion: 1,
        oauthSeq: 3,
        oauth: { p: { ...cred(), method: "browser", provider: "chatgpt", generation: 3 } },
      }),
    );
    expect(await store.credentialStatus("p")).toEqual({});
    expect(await store.resolve("p")).toBeUndefined();
    await store.setCredentials("q", { apiKey: "key-0123456789abcdef" });
    const file = await raw(store);
    expect(file.providers.q).toEqual({ apiKey: "key-0123456789abcdef" });
    expect(file.oauth.p.access).toBe("access-token-0001");
  });

  it("never mixes oauth into the credentials resolve() and active() hand to a provider", async () => {
    const { store } = await fresh();
    await store.saveActive("p", profile(), { apiKey: "key-0123456789abcdef" });
    await store.setOAuth("p", cred(), binding);
    expect((await store.resolve("p"))?.credentials).toEqual({ apiKey: "key-0123456789abcdef" });
    expect((await store.active())?.credentials).toEqual({ apiKey: "key-0123456789abcdef" });
  });

  it("getOAuth returns the entry only to the registration that created it (D21)", async () => {
    const { store } = await fresh();
    await store.setOAuth("p", cred(), binding);
    expect((await store.getOAuth("p", "chatgpt"))?.access).toBe("access-token-0001");
    expect(await store.getOAuth("p", "other")).toBeUndefined();
    expect(await store.getOAuth("missing", "chatgpt")).toBeUndefined();
  });

  it("deleteCredentials removes providers[name] and oauth[name] and reports either (D9)", async () => {
    const { store } = await fresh();
    await store.setOAuth("only-oauth", cred(), binding);
    expect(await store.deleteCredentials("only-oauth")).toBe(true);
    expect((await raw(store)).oauth["only-oauth"]).toBeUndefined();
    expect(await store.deleteCredentials("only-oauth")).toBe(false);
  });
});

describe("saveProfile and the provider binding (OA-AC-44)", () => {
  it("keeps oauth for the same provider type and deletes it for a different one", async () => {
    const { store } = await fresh();
    await writeFile(
      store.credentialsPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: { p: { apiKey: "k-0123456789abcd" } },
        future: 1,
      }),
    );
    await store.saveProfile("p", profile("chatgpt"));
    await store.setOAuth("p", cred(), binding);
    await store.saveProfile("p", { ...profile("chatgpt"), model: "other" });
    expect((await raw(store)).oauth.p).toBeDefined();
    await store.saveProfile("p", profile("openai"));
    const file = await raw(store);
    expect(file.oauth.p).toBeUndefined();
    expect(file.providers.p).toEqual({ apiKey: "k-0123456789abcd" });
    expect(file.future).toBe(1);
    expect((await store.load()).profiles.p?.provider).toBe("openai");
  });

  it("also drops the session when saveActive switches the provider type of a profile", async () => {
    const { store } = await fresh();
    await store.saveProfile("p", profile("chatgpt"));
    await store.setOAuth("p", cred(), binding);
    await store.saveActive("p", profile("openai"), {});
    expect((await raw(store)).oauth.p).toBeUndefined();
  });
});

describe("generation and conditional writes (OA-AC-45)", () => {
  it("assigns a growing generation from oauthSeq that is never reused, not even after delete", async () => {
    const { store } = await fresh();
    expect(await store.setOAuth("p", cred(), binding)).toBe(1);
    expect(await store.setOAuth("p", cred("access-token-0002"), binding)).toBe(2);
    await store.deleteOAuth("p");
    expect(await store.setOAuth("p", cred("access-token-0003"), binding)).toBe(3);
    expect((await raw(store)).oauthSeq).toBe(3);
  });

  it("refuses a write whose expected generation is stale or whose entry is gone", async () => {
    const { store } = await fresh();
    const first = (await store.setOAuth("p", cred(), binding)) as number;
    await store.setOAuth("p", cred("access-token-0002"), binding);
    expect(
      await store.setOAuth("p", cred("access-token-0009"), binding, { expectedGeneration: first }),
    ).toBe(false);
    expect((await store.getOAuthEntry("p"))?.access).toBe("access-token-0002");
    await store.deleteOAuth("p");
    expect(
      await store.setOAuth("p", cred("access-token-0009"), binding, { expectedGeneration: 2 }),
    ).toBe(false);
    expect(await store.getOAuthEntry("p")).toBeUndefined();
  });

  it("honors a guard that turns false (a flow that ended while it waited)", async () => {
    const { store } = await fresh();
    expect(await store.setOAuth("p", cred(), binding, { guard: () => false })).toBe(false);
    expect(await store.getOAuthEntry("p")).toBeUndefined();
    expect(await store.setOAuth("p", cred(), binding, { guard: () => true })).toBe(1);
  });

  it("markOAuthState is conditional on the generation", async () => {
    const { store } = await fresh();
    const generation = (await store.setOAuth("p", cred(), binding)) as number;
    expect(await store.markOAuthState("p", "needs_sign_in", generation + 5)).toBe(false);
    expect((await store.getOAuthEntry("p"))?.state).toBe("ok");
    expect(await store.markOAuthState("p", "needs_sign_in", generation)).toBe(true);
    const entry = await store.getOAuthEntry("p");
    expect(entry?.state).toBe("needs_sign_in");
    expect(entry?.access).toBe("access-token-0001");
    expect(await store.markOAuthState("missing", "needs_sign_in", 1)).toBe(false);
  });
});
