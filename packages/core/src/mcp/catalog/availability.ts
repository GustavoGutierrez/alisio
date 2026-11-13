/**
 * What a catalog entry offers and whether Alisio could install it automatically (specs/030 §19.6).
 * Provider-neutral: it reads only the domain model. The installer (phase 3) re-checks everything
 * against fresh detail; this is the visible, honest summary the list and its filters use.
 */
import type { CatalogEntry } from "./source.ts";

export type BlockedReason = "deprecated" | "deleted" | "schema_unsupported" | "method_unsupported";
export type Execution = "local" | "remote" | "both" | "unknown";

export interface Assessment {
  ready: boolean;
  blocked?: { reason: BlockedReason; detail?: string };
  execution: Execution;
  /** Install methods on offer: package types (`npm`, `pypi`...) and `remote`. */
  methods: string[];
  transports: string[];
}

const NPMJS = "https://registry.npmjs.org";

export function assessEntry(entry: CatalogEntry): Assessment {
  const methods = new Set<string>();
  const transports = new Set<string>();
  for (const pkg of entry.packages) {
    methods.add(pkg.method);
    transports.add(pkg.transport);
  }
  for (const remote of entry.remotes) {
    methods.add("remote");
    transports.add(remote.transport);
  }
  const local = entry.packages.length > 0;
  const remote = entry.remotes.length > 0;
  const execution: Execution =
    local && remote ? "both" : local ? "local" : remote ? "remote" : "unknown";
  const base = { execution, methods: [...methods].sort(), transports: [...transports].sort() };
  if (entry.status === "deprecated" || entry.status === "deleted")
    return { ...base, ready: false, blocked: { reason: entry.status } };
  const npmStdio = entry.packages.some(
    (p) =>
      p.method === "npm" &&
      p.transport === "stdio" &&
      !!p.version &&
      (!p.registryBaseUrl || p.registryBaseUrl.replace(/\/+$/, "") === NPMJS),
  );
  const httpRemote = entry.remotes.some((r) => r.transport === "streamable-http");
  if (npmStdio || httpRemote) return { ...base, ready: true };
  const detail = !methods.size
    ? "no package or remote service"
    : entry.packages.some((p) => p.method === "npm" && p.transport === "stdio" && !p.version)
      ? "npm package without an exact version"
      : [...methods].join(", ");
  return { ...base, ready: false, blocked: { reason: "method_unsupported", detail } };
}
