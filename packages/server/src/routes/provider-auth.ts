/**
 * Provider sign-in flows (specs/025 §5.5). A sign-in runs in the background in the process-wide
 * `AuthFlowRegistry`; the browser starts it, polls its view (steps, the one pending prompt, the
 * outcome), answers prompts and cancels. A view never carries a token, an authorization code or a
 * prompt answer. Everything sits behind the existing guard (Host, Origin, cookie, JSON), and the
 * routes that change state are refused under `--read-only`.
 */
import {
  AuthFlowLimitError,
  type AuthFlowRegistry,
  type ProviderRegistry,
  ProviderSettingsStore,
} from "@alisio/core";
import type { ProviderAuthFlowStarted, ProviderAuthFlowView } from "@alisio/sdk";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, queryInt, validate } from "../schemas.ts";
import { type ManagementContext, workspaceApp } from "./management.ts";
import { PROFILE_NAME } from "./providers.ts";

const METHOD_ID = /^[a-z0-9_-]{1,40}$/;
/** Longest prompt answer the browser may send. */
const MAX_INPUT = 8_192;

export interface ProviderAuthContext {
  flows: AuthFlowRegistry;
  /**
   * Whether plugins may be offered a loopback listener (D16): `declared` when the host says the
   * browser is on this machine, `assumed` when the server merely listens on loopback, false when
   * it is bound for remote access or runs `--read-only`.
   */
  loopback: "declared" | "assumed" | false;
}

export function registerProviderAuthRoutes(
  router: Router,
  ctx: ManagementContext,
  auth: ProviderAuthContext,
): void {
  const store = () => new ProviderSettingsStore();
  /** Registries whose removals already cancel flows (one subscription per registry). */
  const watched = new WeakSet<ProviderRegistry>();

  const refuseReadOnly = () => {
    if (ctx.base.readOnly)
      throw new HttpError("capability_ceiling", "Signing in is unavailable under --read-only");
  };
  const profileParam = (value: string | undefined): string => {
    if (!value || !PROFILE_NAME.test(value))
      throw new HttpError("validation_failed", "Invalid profile name", { fields: ["profile"] });
    return value;
  };
  /** The flow `flowId` of `profile`; another profile's flow is as unknown as a missing one. */
  const flowOf = (profile: string, flowId: string | undefined) => {
    const flow = flowId ? auth.flows.get(flowId) : undefined;
    if (!flow || flow.profile !== profile)
      throw new HttpError("not_found", "Sign-in flow not found");
    return flow;
  };

  router.post("/api/providers/:profile/auth/:method/start", async ({ req, params }) => {
    refuseReadOnly();
    const name = profileParam(params.profile);
    const methodId = params.method;
    if (!methodId || !METHOD_ID.test(methodId))
      throw new HttpError("validation_failed", "Invalid method id", { fields: ["method"] });
    const input = validate<{ workspace?: string }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096) },
    });
    const profile = (await store().load()).profiles[name];
    if (!profile) throw new HttpError("not_found", "Provider profile not found");
    // Any open app serves the provider registrations when no workspace is named.
    const opened = input.workspace
      ? await workspaceApp(ctx.workspaces, input.workspace)
      : ctx.workspaces.entries()[0];
    const registration = opened?.app.providers.get(profile.provider);
    const method = registration?.auth?.find((candidate) => candidate.id === methodId);
    if (!opened || !registration || !method)
      throw new HttpError("not_found", "This provider has no such sign-in method");
    const registry = opened.app.providers;
    if (!watched.has(registry)) {
      watched.add(registry);
      // The plugin was uninstalled or recycled: its pending sign-ins end with it (D28a).
      registry.onRemoved((entry) => auth.flows.cancelRegistration(entry));
    }
    try {
      const flow = auth.flows.start({
        profile: name,
        providerId: registration.id,
        method,
        registrationKey: registration,
        loopback: auth.loopback,
      });
      const body: ProviderAuthFlowStarted = { flowId: flow.id };
      return { status: 202, body };
    } catch (error) {
      if (error instanceof AuthFlowLimitError)
        throw new HttpError("validation_failed", error.message, { fields: ["flows"] });
      throw error;
    }
  });

  router.get("/api/providers/:profile/auth/flows/:flowId", ({ url, params }) => {
    const flow = flowOf(profileParam(params.profile), params.flowId);
    const after = queryInt(url, "after", 0) ?? 0;
    const body: ProviderAuthFlowView = flow.view(after);
    return { body };
  });

  router.post("/api/providers/:profile/auth/flows/:flowId/input", async ({ req, params }) => {
    refuseReadOnly();
    const flow = flowOf(profileParam(params.profile), params.flowId);
    const input = validate<{ promptId: string; value: string }>(await readJson(req), {
      promptId: { check: is.nonEmpty(100), required: true },
      value: { check: is.string(MAX_INPUT), required: true },
    });
    if (flow.input(input.promptId, input.value) !== "accepted")
      throw new HttpError("validation_failed", "No such prompt is waiting for an answer", {
        fields: ["promptId"],
      });
    const body: ProviderAuthFlowView = flow.view(Number.MAX_SAFE_INTEGER);
    return { body };
  });

  router.delete("/api/providers/:profile/auth/flows/:flowId", ({ params }) => {
    refuseReadOnly();
    const flow = flowOf(profileParam(params.profile), params.flowId);
    flow.cancel();
    const body: ProviderAuthFlowView = flow.view(Number.MAX_SAFE_INTEGER);
    return { body };
  });
}
