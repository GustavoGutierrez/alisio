import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskSecret, ProviderSettingsStore, settableSettings } from "../packages/core/src/index.ts";

const SECRET = "sk-test-0123456789abcdefXYZ";

async function store() {
  const root = await mkdtemp(join(tmpdir(), "alisio-credentials-"));
  const settings = new ProviderSettingsStore(root);
  await settings.saveActive(
    "work",
    { provider: "openai-compatible", values: { baseURL: "https://x.test/v1" }, model: "m" },
    { apiKey: SECRET },
  );
  return { root, settings };
}

describe("provider credential store (write-only surface)", () => {
  it("masks secrets to a short tail, and hides short secrets entirely", () => {
    expect(maskSecret(SECRET)).toBe("…XYZ");
    expect(maskSecret("short-one")).toBeUndefined();
  });

  it("reports stored credentials only as masked status", async () => {
    const { settings } = await store();
    const status = await settings.credentialStatus("work");
    expect(status).toEqual({ apiKey: { tail: "…XYZ" } });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(await settings.credentialStatus("missing")).toEqual({});
  });

  it("merges new credentials atomically with 0600 permissions and deletes them", async () => {
    const { settings } = await store();
    await settings.setCredentials("work", { bearerToken: "bt-abcdefghijklmnop123" });
    const raw = JSON.parse(await readFile(settings.credentialsPath, "utf8"));
    expect(raw.providers.work).toEqual({ apiKey: SECRET, bearerToken: "bt-abcdefghijklmnop123" });
    expect((await stat(settings.credentialsPath)).mode & 0o777).toBe(0o600);
    expect(await settings.deleteCredentials("work")).toBe(true);
    expect(await settings.deleteCredentials("work")).toBe(false);
    expect(await settings.credentialStatus("work")).toEqual({});
  });

  it("saves a profile without changing the active one", async () => {
    const { settings } = await store();
    await settings.saveProfile("lab", {
      provider: "openai-compatible",
      values: { baseURL: "http://127.0.0.1:8080/v1" },
      model: "local",
    });
    const loaded = await settings.load();
    expect(loaded.active).toBe("work");
    expect(loaded.profiles.lab?.model).toBe("local");
    expect((await stat(settings.profilesPath)).mode & 0o777).toBe(0o600);
  });
});

describe("settable settings metadata", () => {
  it("describes every settable key with its value kind", () => {
    const list = settableSettings();
    const byKey = Object.fromEntries(list.map((s) => [s.key, s]));
    expect(byKey["compaction.auto"]).toMatchObject({ kind: "boolean" });
    expect(byKey["limits.maxTurns"]).toMatchObject({ kind: "number" });
    expect(byKey["websearch.provider"]?.kind).toBe("enum");
    expect(byKey["websearch.provider"]?.options?.length).toBeGreaterThan(1);
    expect(byKey["agents.active"]).toMatchObject({ kind: "string" });
  });
});
