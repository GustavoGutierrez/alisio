/**
 * The logic behind Settings → Forja (Forja spec §11.2, Python spec §9.4): the two keys the page
 * edits, one card per Python backend (readiness, isolation in words, profiles, reason, setup
 * command), the backend `auto` would use now, the mode label (the "Managed: your own Python" bug
 * under `auto`), and the JavaScript engine's limits in human units.
 */
import type { EngineDescriptor, ForgeOverview } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { settableSettings } from "../packages/core/src/index.ts";
import {
  backendCards,
  effectiveBackend,
  FORGE_KEYS,
  isForgeKey,
  javascriptFacts,
  modeLabelKey,
  settingsPageFor,
} from "../packages/web/src/util/forge-page.ts";

const engine = (
  id: EngineDescriptor["id"],
  patch: Partial<EngineDescriptor> = {},
): EngineDescriptor => ({
  id,
  language: "python",
  version: "3.12",
  isolation: id === "python-oci" ? "os-container" : id === "python-wasm" ? "wasm-process" : "none",
  ready: true,
  capabilities: {
    cooperativeInterrupt: true,
    hardTermination: true,
    hardMemoryLimit: id !== "python-managed",
    networkDeniedByOS: id !== "python-managed",
    toolCalls: true,
  },
  ...patch,
});
const READY = [engine("python-oci"), engine("python-wasm"), engine("python-managed")];

describe("keys of the Forja page", () => {
  it("owns exactly the forge keys the config lets the web change", () => {
    const accepted = settableSettings()
      .map((s) => s.key)
      .filter(isForgeKey);
    expect([...FORGE_KEYS].sort()).toEqual([...accepted].sort());
    expect(isForgeKey("forge.scratch.maxBytes")).toBe(true);
    expect(isForgeKey("limits.timeoutMs")).toBe(false);
  });
});

describe("mode label", () => {
  it("does not call `auto` Managed (the former bug) and has a text for every mode", () => {
    const keys = (["auto", "managed", "oci", "wasm"] as const).map(modeLabelKey);
    expect(new Set(keys).size).toBe(4);
    expect(modeLabelKey("auto")).not.toBe(modeLabelKey("managed"));
  });
});

describe("Python backend cards", () => {
  it("lists oci, wasm and managed in the order `auto` tries them", () => {
    const cards = backendCards({ mode: "auto", backends: [READY[2], READY[0], READY[1]] as never });
    expect(cards.map((c) => c.id)).toEqual(["oci", "wasm", "managed"]);
  });

  it("states readiness, isolation text and icon, profiles and the reason for a backend that is not ready", () => {
    const cards = backendCards({
      mode: "auto",
      backends: [
        engine("python-oci", { ready: false, reason: "docker is not installed" }),
        engine("python-wasm", { profiles: ["analysis", "science"] }),
        engine("python-managed"),
      ],
    });
    const [oci, wasm, managed] = cards;
    expect(oci).toMatchObject({
      ready: false,
      reason: "docker is not installed",
      setup: "alisio analysis setup --oci",
      isolation: "os-container",
      sandboxed: true,
    });
    expect(wasm).toMatchObject({
      ready: true,
      profiles: ["analysis", "science"],
      isolation: "wasm-process",
    });
    expect(wasm?.setup).toBeUndefined();
    // Running on the host is said in words and has its own icon.
    expect(managed).toMatchObject({ isolation: "none", sandboxed: false, icon: "alert" });
    expect(oci?.icon).toBe("shield");
    expect(new Set(cards.map((c) => c.isolationKey)).size).toBe(3);
  });

  it("offers the wasm setup command while wasm is not ready, and none for managed", () => {
    const [, wasm, managed] = backendCards({
      mode: "wasm",
      backends: [
        engine("python-oci"),
        engine("python-wasm", { ready: false, reason: "not prepared" }),
        engine("python-managed", { ready: false, reason: "no Python found" }),
      ],
    });
    expect(wasm?.setup).toBe("alisio analysis setup --wasm");
    expect(managed?.setup).toBeUndefined();
    expect(managed?.reason).toBe("no Python found");
  });

  it("gives no cards when the server predates the backends list", () => {
    expect(backendCards({ mode: "managed" })).toEqual([]);
  });

  it("marks the backend that would run now", () => {
    const cards = backendCards({
      mode: "auto",
      isolation: "preferred",
      backends: [
        engine("python-oci", { ready: false, reason: "x" }),
        engine("python-wasm"),
        engine("python-managed"),
      ],
    });
    expect(cards.filter((c) => c.current).map((c) => c.id)).toEqual(["wasm"]);
  });
});

describe("effective backend", () => {
  const backends = [
    engine("python-oci", { ready: false, reason: "x" }),
    engine("python-wasm", { ready: false, reason: "y" }),
    engine("python-managed"),
  ];
  it("takes the most isolated ready one under auto, host included only when preferred", () => {
    expect(effectiveBackend("auto", "preferred", READY)).toBe("oci");
    expect(effectiveBackend("auto", "preferred", backends)).toBe("managed");
    expect(effectiveBackend("auto", "required", backends)).toBeUndefined();
  });

  it("strict only accepts a backend whose network the OS denies", () => {
    const openWasm = [
      engine("python-wasm", {
        capabilities: { ...READY[1]?.capabilities, networkDeniedByOS: false } as never,
      }),
    ];
    expect(effectiveBackend("auto", "strict", openWasm)).toBeUndefined();
    expect(effectiveBackend("auto", "strict", READY)).toBe("oci");
  });

  it("an explicit runtime is that backend when it is ready and allowed, else nothing", () => {
    expect(effectiveBackend("wasm", "preferred", READY)).toBe("wasm");
    expect(effectiveBackend("managed", "required", READY)).toBeUndefined();
    expect(effectiveBackend("oci", "preferred", backends)).toBeUndefined();
  });
});

describe("JavaScript engine facts", () => {
  const forge = {
    engines: [],
    javascript: {
      verified: true,
      enabled: true,
      host: "worker",
      hostSetting: "auto",
      wasmSha256: "a".repeat(64),
      version: "quickjs-wasi@3.6.2",
      limits: {
        maxSourceBytes: 65_536,
        timeoutMs: 30_000,
        memoryBytes: 33_554_432,
        stackBytes: 262_144,
        maxToolCalls: 50,
        maxConcurrency: 4,
        maxCallInputBytes: 1,
        maxCallResponseBytes: 1,
        maxRetainedOutputBytes: 1,
        maxOutputChars: 16_000,
      },
    },
    scratch: { enabled: true, retentionDays: 7, maxBytes: 268_435_456 },
    state: { enabled: true },
    guides: { enabled: true },
  } as ForgeOverview;

  it("shortens the hash, reports the host in effect and its setting, and formats the limits", () => {
    const facts = javascriptFacts(forge);
    expect(facts).toMatchObject({
      version: "quickjs-wasi@3.6.2",
      hash: "aaaaaaaaaaaa",
      host: "worker",
      hostSetting: "auto",
      verified: true,
    });
    expect(facts.limits).toEqual([
      { id: "timeout", value: "30 s" },
      { id: "memory", value: "32 MB" },
      { id: "stack", value: "256 KB" },
      { id: "toolCalls", value: "50" },
      { id: "concurrency", value: "4" },
      { id: "outputChars", value: "16,000" },
    ]);
  });
});

describe("settings page ids", () => {
  it("sends the former Data analysis page to Forja and unknown ids to General", () => {
    expect(settingsPageFor("analysis")).toBe("forge");
    expect(settingsPageFor("forge")).toBe("forge");
    expect(settingsPageFor("models")).toBe("models");
    expect(settingsPageFor("nonsense")).toBe("general");
    expect(settingsPageFor(undefined)).toBe("general");
  });
});
