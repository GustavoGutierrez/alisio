/**
 * Turns a validated plan plus the user's answers into the configuration entry, the secrets to
 * store and nothing else (specs/030 D8, D17). Everything is structured data: no command comes from
 * a catalog card, arguments are never concatenated into a shell string, secrets become references.
 */
import type { CatalogInput } from "../catalog/source.ts";
import { McpInstallError } from "./errors.ts";
import { secretId } from "./secrets.ts";

export interface PlanInput {
  /** `<kind>.<name>`: the key the client answers with. */
  id: string;
  kind: "env" | "header" | "variable";
  name: string;
  secret: boolean;
  required: boolean;
  description?: string;
  format?: string;
  choices?: string[];
  default?: string;
}

export const inputId = (input: Pick<CatalogInput, "kind" | "name">) =>
  `${input.kind}.${input.name}`;

const MAX_VALUE = 4096;
const MAX_SECRET = 8192;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const toPlanInput = (input: CatalogInput): PlanInput => ({
  id: inputId(input),
  kind: input.kind,
  name: input.name,
  secret: input.isSecret,
  required: input.isRequired,
  ...(input.description ? { description: input.description } : {}),
  ...(input.format ? { format: input.format } : {}),
  ...(input.choices?.length ? { choices: input.choices } : {}),
  ...(input.default !== undefined && !input.isSecret ? { default: input.default } : {}),
});

/** What the user must be asked: required, no safe default, no value fixed by the provider. */
export const isAsked = (input: CatalogInput): boolean =>
  input.isRequired && input.default === undefined && input.value === undefined;

/** Server-side validation of one answer; the message names the field, never the value. */
export function validateAnswer(input: PlanInput, value: string): string | undefined {
  const limit = input.secret ? MAX_SECRET : MAX_VALUE;
  if (value.length === 0) return "is required";
  if (value.length > limit) return "is too long";
  if (CONTROL.test(value)) return "contains characters that are not allowed";
  if (input.secret && value !== value.trim()) return "has spaces at the start or end";
  if (input.choices?.length && !input.choices.includes(value)) return "is not one of the options";
  const format = input.format?.toLowerCase();
  if (format === "number" && !Number.isFinite(Number(value))) return "must be a number";
  if (format === "boolean" && value !== "true" && value !== "false") return "must be true or false";
  if (input.kind === "variable" && !/^[A-Za-z0-9._:-]+$/.test(value))
    return "must be a host name or a simple value";
  return undefined;
}

/** The answers to use: the user's value, else the default or fixed value; errors name fields only. */
export function collectAnswers(
  all: CatalogInput[],
  given: Record<string, unknown>,
): Record<string, string> {
  const known = new Set(all.map(inputId));
  const problems: string[] = Object.keys(given).filter((key) => !known.has(key));
  const answers: Record<string, string> = {};
  for (const input of all) {
    const id = inputId(input);
    const supplied = given[id];
    if (supplied !== undefined && typeof supplied !== "string") {
      problems.push(id);
      continue;
    }
    if (input.value !== undefined && !input.isSecret) {
      answers[id] = input.value;
      continue;
    }
    const typed = supplied !== undefined && supplied !== "" ? supplied : undefined;
    const value = typed ?? input.default;
    if (value === undefined || value === "") {
      if (input.isRequired) problems.push(id);
      continue;
    }
    // A default is the provider's own value: only what the user typed is held to the checks.
    if (typed !== undefined && validateAnswer(toPlanInput(input), typed)) problems.push(id);
    answers[id] = value;
  }
  if (problems.length)
    throw new McpInstallError(
      "mcp_input_required",
      "Some required information is missing or not valid",
      {
        fields: [...new Set(problems)],
      },
    );
  return answers;
}

export interface BuiltEntry {
  entry: Record<string, unknown>;
  /** Secret id → value, stored before the entry is written. */
  secrets: Record<string, string>;
}

/** A bare token for `Authorization` is sent as a bearer token (the convention the catalog shows). */
export const headerValue = (name: string, value: string) =>
  name.toLowerCase() === "authorization" && !/\s/.test(value) ? `Bearer ${value}` : value;

export function buildNpmEntry(input: {
  bindingId: string;
  binPath: string;
  args: string[];
  inputs: CatalogInput[];
  answers: Record<string, string>;
}): BuiltEntry {
  const env: Record<string, string> = {};
  const secretEnv: Record<string, { secret: string }> = {};
  const secrets: Record<string, string> = {};
  for (const item of input.inputs) {
    if (item.kind !== "env") continue;
    const value = input.answers[inputId(item)];
    if (value === undefined) continue;
    if (item.isSecret) {
      const id = secretId(input.bindingId, "env", item.name);
      secrets[id] = value;
      secretEnv[item.name] = { secret: id };
    } else env[item.name] = value;
  }
  return {
    entry: {
      transport: "stdio",
      command: "node",
      args: [input.binPath, ...input.args],
      envAllow: [],
      ...(Object.keys(env).length ? { env } : {}),
      ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
      enabled: true,
    },
    secrets,
  };
}

export function buildRemoteEntry(input: {
  bindingId: string;
  url: string;
  inputs: CatalogInput[];
  answers: Record<string, string>;
}): BuiltEntry & { url: string } {
  let url = input.url;
  for (const item of input.inputs)
    if (item.kind === "variable") {
      const value = input.answers[inputId(item)];
      if (value !== undefined) url = url.split(`{${item.name}}`).join(value);
    }
  const headers: Record<string, { secret: string }> = {};
  const secrets: Record<string, string> = {};
  for (const item of input.inputs) {
    if (item.kind !== "header") continue;
    const value = input.answers[inputId(item)];
    if (value === undefined) continue;
    // Every header value is protected, not only the ones flagged secret: a "public" header can
    // still identify the user, and the configuration file may be shared.
    const id = secretId(input.bindingId, "header", item.name);
    secrets[id] = headerValue(item.name, value);
    headers[item.name] = { secret: id };
  }
  return {
    url,
    entry: {
      transport: "http",
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      enabled: true,
    },
    secrets,
  };
}

/** Whether the URL still contains an unresolved `{variable}`. */
export const hasPlaceholder = (url: string): boolean => /\{[^}]+\}/.test(url);
