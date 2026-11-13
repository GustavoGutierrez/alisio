/**
 * Pure model of the detail card of a catalog entry (specs/030 §12.1 "Ficha de MCP"): a readable
 * provider, where it runs, what it needs and will ask for, honest compatibility and only safe
 * links. Catalog text is data from a publisher: it is shown as plain text and never as HTML.
 */
import type { McpCatalogDetail } from "@alisio/sdk";
import { blockedReason, unsupportedKey } from "../mcp-install/model.ts";
import type { InstallStringKey } from "../mcp-install/strings.ts";
import { safeAuthUrl } from "../mcp-manage/model.ts";

export interface Provider {
  kind: "github" | "domain";
  name: string;
}

/** `io.github.acme/files` → acme on GitHub; `com.example/x` → example.com. */
export function providerOf(name: string): Provider {
  const namespace = name.split("/")[0] ?? name;
  const github = /^io\.github\.(.+)$/i.exec(namespace);
  if (github?.[1]) return { kind: "github", name: github[1] };
  return { kind: "domain", name: namespace.split(".").reverse().join(".") };
}

export interface DetailRequirement {
  name: string;
  secret: boolean;
}

export interface DetailView {
  title: string;
  description: string;
  version: string;
  provider: Provider;
  execution: McpCatalogDetail["execution"];
  /** Origin of a remote service (scheme and host only). */
  origin?: string;
  runtime: "node" | "none";
  required: DetailRequirement[];
  optionalCount: number;
  links: Array<{ kind: "website" | "repository"; url: string }>;
  installable: boolean;
  blockedKey?: InstallStringKey;
}

export function detailViewOf(detail: McpCatalogDetail): DetailView {
  const pkg = detail.packages.find((p) => p.method === "npm") ?? detail.packages[0];
  const remote = detail.remotes[0];
  const inputs = (pkg?.inputs ?? remote?.inputs ?? []).filter((i) => i.kind !== "variable");
  const links: DetailView["links"] = [];
  const website = safeAuthUrl(detail.websiteUrl);
  const repository = safeAuthUrl(detail.repositoryUrl);
  if (website) links.push({ kind: "website", url: website });
  if (repository) links.push({ kind: "repository", url: repository });
  const reason = detail.ready ? undefined : blockedReason(detail);
  return {
    title: detail.title ?? detail.name,
    description: detail.description,
    version: detail.version,
    provider: providerOf(detail.name),
    execution: detail.execution,
    ...(remote?.origin ? { origin: remote.origin } : {}),
    runtime: pkg?.method === "npm" && !remote ? "node" : "none",
    required: inputs
      .filter((i) => i.isRequired && i.default === undefined)
      .map((i) => ({ name: i.name, secret: i.isSecret })),
    optionalCount: inputs.filter((i) => !i.isRequired || i.default !== undefined).length,
    links,
    installable: detail.ready,
    ...(!detail.ready ? { blockedKey: unsupportedKey(reason) } : {}),
  };
}
