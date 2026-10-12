/**
 * Pure logic of Settings → Forja (Forja spec §11.2, Python spec §9.4): the two settable keys, one
 * card per Python backend, the backend `auto` would use now (the selector's own order and policy
 * rules, read only), the mode label and the JavaScript engine's limits in human units.
 */
import type { AnalysisStatus, EngineDescriptor, ForgeOverview, IsolationLevel } from "@alisio/sdk";
import type { MessageKey } from "../i18n/en.ts";

/** The forge keys the web may change; every other `forge.*` key is read only here. */
export const FORGE_KEYS = ["forge.javascript.enabled", "forge.guides.enabled"] as const;
export type ForgeKey = (typeof FORGE_KEYS)[number];

/** Keys of the Forja page: the General page leaves them out. */
export const isForgeKey = (key: string): boolean => key.startsWith("forge.");

type Mode = AnalysisStatus["mode"];
type Policy = NonNullable<AnalysisStatus["isolation"]>;
export type BackendId = "oci" | "wasm" | "managed";

const MODE_LABELS: Record<Mode, MessageKey> = {
  auto: "settings.analysis.mode.auto",
  managed: "settings.analysis.mode.managed",
  oci: "settings.analysis.mode.oci",
  wasm: "settings.analysis.mode.wasm",
};
export const modeLabelKey = (mode: Mode): MessageKey => MODE_LABELS[mode];

/** `auto` tries the backends in this order (most isolated first). */
const ORDER: readonly BackendId[] = ["oci", "wasm", "managed"];
const SETUP: Partial<Record<BackendId, string>> = {
  oci: "alisio analysis setup --oci",
  wasm: "alisio analysis setup --wasm",
};

const ISOLATION_KEYS: Record<IsolationLevel, MessageKey> = {
  "os-container": "forge.isolation.osContainer",
  "wasm-isolate": "forge.isolation.wasmIsolate",
  "wasm-process": "forge.isolation.wasmProcess",
  none: "forge.isolation.none",
};
export const isolationKey = (level: IsolationLevel): MessageKey => ISOLATION_KEYS[level];

const backendOf = (engine: EngineDescriptor): BackendId | undefined =>
  engine.id === "python-oci"
    ? "oci"
    : engine.id === "python-wasm"
      ? "wasm"
      : engine.id === "python-managed"
        ? "managed"
        : undefined;

/**
 * The backend that would run a script now: the explicit runtime when it is ready and the policy
 * allows it, otherwise (under `auto`) the first eligible of oci, wasm, managed. `required` and
 * `strict` leave out the host; `strict` also needs the OS to deny the network.
 */
export function effectiveBackend(
  mode: Mode,
  isolation: Policy | undefined,
  backends: readonly EngineDescriptor[],
): BackendId | undefined {
  const policy = isolation ?? "preferred";
  const byId = new Map<BackendId, EngineDescriptor>();
  for (const engine of backends) {
    const id = backendOf(engine);
    if (id) byId.set(id, engine);
  }
  const eligible = (id: BackendId): boolean => {
    const engine = byId.get(id);
    if (!engine?.ready) return false;
    if (id === "managed" && policy !== "preferred") return false;
    if (policy === "strict" && !engine.capabilities.networkDeniedByOS) return false;
    return true;
  };
  if (mode !== "auto") return eligible(mode) ? mode : undefined;
  return ORDER.find(eligible);
}

export interface BackendCard {
  id: BackendId;
  engine: EngineDescriptor["id"];
  ready: boolean;
  isolation: IsolationLevel;
  isolationKey: MessageKey;
  icon: "shield" | "alert";
  /** False only for the host: code there runs with the user's own privileges. */
  sandboxed: boolean;
  profiles: string[];
  reason?: string;
  /** The command that makes the backend ready (never run by the page). */
  setup?: string;
  /** This backend runs the next script under the current runtime and policy. */
  current: boolean;
}

/** One card per backend in the order `auto` tries them; empty when the server lists none. */
export function backendCards(
  status: Pick<AnalysisStatus, "mode" | "isolation" | "backends">,
): BackendCard[] {
  const backends = status.backends ?? [];
  const current = effectiveBackend(status.mode, status.isolation, backends);
  const cards: BackendCard[] = [];
  for (const id of ORDER) {
    const engine = backends.find((candidate) => backendOf(candidate) === id);
    if (!engine) continue;
    const setup = engine.ready ? undefined : SETUP[id];
    cards.push({
      id,
      engine: engine.id,
      ready: engine.ready,
      isolation: engine.isolation,
      isolationKey: isolationKey(engine.isolation),
      icon: engine.isolation === "none" ? "alert" : "shield",
      sandboxed: engine.isolation !== "none",
      profiles: engine.profiles ?? [],
      ...(!engine.ready && engine.reason ? { reason: engine.reason } : {}),
      ...(setup ? { setup } : {}),
      current: current === id,
    });
  }
  return cards;
}

export interface JavascriptFacts {
  version: string;
  /** The first 12 hex digits of the WASM module's SHA-256. */
  hash: string;
  verified: boolean;
  verification?: string;
  enabled: boolean;
  /** Where the engine runs now, and what `forge.javascript.host` asks for. */
  host: "worker" | "process";
  hostSetting: "auto" | "worker" | "process";
  limits: Array<{
    id: "timeout" | "memory" | "stack" | "toolCalls" | "concurrency" | "outputChars";
    value: string;
  }>;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;
const kilobytes = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

export function javascriptFacts(forge: ForgeOverview): JavascriptFacts {
  const js = forge.javascript;
  return {
    version: js.version,
    hash: js.wasmSha256.slice(0, 12),
    verified: js.verified,
    ...(js.verification ? { verification: js.verification } : {}),
    enabled: js.enabled,
    host: js.host,
    hostSetting: js.hostSetting,
    limits: [
      { id: "timeout", value: `${Math.round(js.limits.timeoutMs / 1000)} s` },
      { id: "memory", value: megabytes(js.limits.memoryBytes) },
      { id: "stack", value: kilobytes(js.limits.stackBytes) },
      { id: "toolCalls", value: String(js.limits.maxToolCalls) },
      { id: "concurrency", value: String(js.limits.maxConcurrency) },
      { id: "outputChars", value: js.limits.maxOutputChars.toLocaleString("en-US") },
    ],
  };
}

export type SettingsPage =
  | "general"
  | "models"
  | "plugins"
  | "skills"
  | "mcp"
  | "agents"
  | "forge"
  | "appearance"
  | "about";

const SETTINGS_PAGES: readonly SettingsPage[] = [
  "general",
  "models",
  "plugins",
  "skills",
  "mcp",
  "agents",
  "forge",
  "appearance",
  "about",
];

/** The page a requested id opens: the former Data analysis page is now Forja, unknown is General. */
export function settingsPageFor(id: string | undefined): SettingsPage {
  if (id === "analysis") return "forge";
  return SETTINGS_PAGES.find((page) => page === id) ?? "general";
}
