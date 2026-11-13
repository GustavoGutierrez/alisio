/**
 * The connection test of one MCP integration (specs/030 UX-07, D12): an ISOLATED diagnostic
 * session. It builds its own client and transport (the same credential resolution as the live
 * connector), connects, lists what the server announces and closes. It registers nothing, calls no
 * tool, reads no resource, gets no prompt, never touches a live connection and never switches a
 * disabled server on. It needs the MCP consent because a local server is a program that runs and a
 * remote one receives requests. A successful result proves connection and discovery at that moment:
 * not a security audit and not that any tool works.
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import type { ServerConfig } from "../config.ts";
import { loadVersion } from "../version.ts";
import type { McpOAuthPort } from "./auth/oauth-flow.ts";
import type { OAuthKey } from "./auth/oauth-provider.ts";
import {
  createMcpTransport,
  type McpSecretResolver,
  SIGN_IN_FAILURE,
  safeFailure,
} from "./connector.ts";

export type ConnectionTestStepId = "prepare" | "connect" | "authenticate" | "discover";
export type ConnectionTestStepStatus = "passed" | "failed" | "skipped";
export interface ConnectionTestStep {
  id: ConnectionTestStepId;
  status: ConnectionTestStepStatus;
}
/** What the user can do next, as the UI words it. */
export type ConnectionRecoveryAction =
  | "retry"
  | "sign-in"
  | "change-key"
  | "install-runtime"
  | "configure"
  | "turn-on";

export interface ConnectionTestOutcome {
  status: "passed" | "failed" | "cancelled";
  steps: ConnectionTestStep[];
  startedAt: string;
  finishedAt: string;
  safeMessage: string;
  recoveryAction?: ConnectionRecoveryAction;
  capabilities: string[];
  counts: { tools: number; resources: number; prompts: number };
}

/** The test was refused before it started (no consent, read-only). */
export class McpConnectionTestError extends Error {
  readonly code = "mcp_not_permitted";
  constructor(message: string) {
    super(message);
    this.name = "McpConnectionTestError";
  }
}

export interface ConnectionTestInput {
  server: ServerConfig;
  workspace: string;
  /** The workspace's MCP consent: a test runs code or makes requests, so it needs `granted`. */
  permission: "granted" | "not-granted" | "read-only";
  secrets?: McpSecretResolver;
  oauth?: McpOAuthPort;
  oauthKey?: OAuthKey;
  signal?: AbortSignal;
  /** Overall limit (default 30 s). */
  timeoutMs?: number;
  now?: () => Date;
}

export const CONNECTION_TEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/**
 * Identity of what a test proved: the entry (switching it on or off does not change it), the
 * registry version and the credential revision. A different value means the result is out of date.
 */
export function connectionFingerprint(input: {
  server: ServerConfig;
  version: string;
  credentialRevision: number;
}): string {
  const { enabled: _enabled, ...entry } = input.server as ServerConfig & { enabled?: boolean };
  return createHash("sha256")
    .update(stable({ entry, version: input.version, credentialRevision: input.credentialRevision }))
    .digest("hex");
}

const MESSAGES: Record<ConnectionRecoveryAction, string> = {
  retry: "We could not connect to the service",
  "sign-in": "Sign in to this service to continue",
  "change-key": "We could not access your account",
  "install-runtime": "A component needed to run this tool is missing",
  configure: "This integration needs to be configured",
  "turn-on": "Turn the integration on to use it",
};

function classify(failure: string): ConnectionRecoveryAction {
  if (failure === SIGN_IN_FAILURE) return "sign-in";
  if (failure.startsWith("Authentication")) return "change-key";
  if (failure.includes("could not be started")) return "install-runtime";
  return "retry";
}

export async function runConnectionTest(
  input: ConnectionTestInput,
): Promise<ConnectionTestOutcome> {
  if (input.permission === "read-only")
    throw new McpConnectionTestError("MCP is unavailable under --read-only");
  if (input.permission !== "granted")
    throw new McpConnectionTestError(
      "Grant MCP access for this workspace first (MCP servers run with your user privileges)",
    );
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const steps: ConnectionTestStep[] = [
    { id: "prepare", status: "skipped" },
    { id: "connect", status: "skipped" },
    { id: "authenticate", status: "skipped" },
    { id: "discover", status: "skipped" },
  ];
  const step = (id: ConnectionTestStepId, status: ConnectionTestStepStatus) => {
    const found = steps.find((item) => item.id === id);
    if (found) found.status = status;
  };
  const empty = { tools: 0, resources: 0, prompts: 0 };
  const finish = (
    status: ConnectionTestOutcome["status"],
    safeMessage: string,
    extra: Partial<ConnectionTestOutcome> = {},
  ): ConnectionTestOutcome => ({
    status,
    steps,
    startedAt,
    finishedAt: now().toISOString(),
    safeMessage,
    capabilities: [],
    counts: empty,
    ...extra,
  });

  const oauthInPlay =
    input.server.transport === "http" &&
    !input.server.bearerTokenEnv &&
    !Object.keys(input.server.headers ?? {}).length &&
    !!input.oauth &&
    !!input.oauthKey;
  const authInPlay =
    oauthInPlay ||
    (input.server.transport === "http" &&
      (!!input.server.bearerTokenEnv || Object.keys(input.server.headers ?? {}).length > 0));

  const prepared = await createMcpTransport({
    name: "check",
    config: input.server,
    workspace: input.workspace,
    ...(input.secrets ? { secrets: input.secrets } : {}),
    ...(oauthInPlay
      ? { oauth: input.oauth as McpOAuthPort, oauthKey: input.oauthKey as OAuthKey }
      : {}),
  });
  if ("blocked" in prepared) {
    step("prepare", "failed");
    const action: ConnectionRecoveryAction =
      input.server.transport === "http" &&
      input.server.bearerTokenEnv &&
      !prepared.blocked.reason.includes("key")
        ? "configure"
        : "change-key";
    return finish("failed", MESSAGES[action], { recoveryAction: action });
  }
  step("prepare", "passed");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();

  const client = new Client(
    { name: "alisio", version: loadVersion(import.meta.url) },
    { capabilities: {} },
  );
  let reachedServer = false;
  try {
    await client.connect(prepared.transport, {
      signal: controller.signal,
      timeout: Math.min(CONNECT_TIMEOUT_MS, input.timeoutMs ?? CONNECT_TIMEOUT_MS),
    });
    reachedServer = true;
    step("connect", "passed");
    if (authInPlay) step("authenticate", "passed");
    const announced = client.getServerCapabilities() ?? {};
    const capabilities = Object.keys(announced).sort();
    const options = { signal: controller.signal, timeout: CONNECT_TIMEOUT_MS };
    const counts = {
      tools: announced.tools ? (await client.listTools(undefined, options)).tools.length : 0,
      resources: announced.resources
        ? (await client.listResources(undefined, options)).resources.length
        : 0,
      prompts: announced.prompts
        ? (await client.listPrompts(undefined, options)).prompts.length
        : 0,
    };
    step("discover", "passed");
    return finish("passed", "Connected, and the capabilities it announces were listed", {
      capabilities,
      counts,
    });
  } catch (error) {
    const cancelled = !timedOut && (input.signal?.aborted ?? false);
    const wasReached = reachedServer;
    if (cancelled) {
      step("connect", wasReached ? "passed" : "failed");
      return finish("cancelled", "The check was cancelled", { recoveryAction: "retry" });
    }
    if (timedOut) {
      step(wasReached ? "discover" : "connect", "failed");
      return finish("failed", "The check took too long and was stopped", {
        recoveryAction: "retry",
      });
    }
    const failure = safeFailure(error, oauthInPlay);
    const action = classify(failure);
    if (action === "sign-in" || action === "change-key") {
      step("connect", "passed");
      step("authenticate", "failed");
    } else step(wasReached ? "discover" : "connect", "failed");
    return finish("failed", MESSAGES[action], { recoveryAction: action });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    await client.close().catch(() => {});
  }
}
