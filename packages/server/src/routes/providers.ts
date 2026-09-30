/**
 * Providers, models and credentials (RF-15, §8.2). Credentials are write-only: requests may set
 * or delete them, but no response carries a value, only `{configured, source, tail?}`. Request
 * bodies are never logged (the server logs routes and status codes only). Activating a profile
 * changes the provider of one workspace application, so it is refused while that workspace has
 * runs (P-01: 409 `runs_active`).
 */
import { maskSecret, ProviderSettingsStore } from "@alisio/core";
import type {
  CredentialStatus,
  ProviderConfigurationField,
  ProviderConfigurationValue,
  ProviderModelsInfo,
  ProviderProfileInfo,
  ProvidersOverview,
  ProviderTypeInfo,
} from "@alisio/sdk";
import type { OpenWorkspace } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";
import { type ManagementContext, type WorkspaceRecycler, workspaceApp } from "./management.ts";

/** Credential keys the web may write (RF-15). */
const CREDENTIAL_KEYS = ["apiKey", "bearerToken"] as const;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const secretValue = (v: unknown) => typeof v === "string" && /^\S{1,4096}$/.test(v);

type Registration = ProviderTypeInfo & { fields: ProviderConfigurationField[] };

function typesOf(opened: OpenWorkspace | undefined): Registration[] {
  return (
    opened?.app.providers.list().map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      fields: r.fields.map((field) => {
        // A secret field never carries a default value to the client.
        const { defaultValue, ...rest } = field;
        return field.kind === "secret" || defaultValue === undefined
          ? { ...rest }
          : { ...rest, defaultValue };
      }),
    })) ?? []
  );
}

async function credentialStatus(
  store: ProviderSettingsStore,
  name: string,
  values: Record<string, ProviderConfigurationValue>,
  type: Registration | undefined,
): Promise<Record<string, CredentialStatus>> {
  const stored = await store.credentialStatus(name);
  const keys = new Set<string>([
    ...Object.keys(stored),
    ...(type?.fields.filter((f) => f.kind === "secret").map((f) => f.key) ?? []),
    ...CREDENTIAL_KEYS.filter((key) => `${key}Env` in values),
  ]);
  if (!type && !keys.size) keys.add("apiKey");
  const out: Record<string, CredentialStatus> = {};
  for (const key of keys) {
    const file = stored[key];
    const env = values[`${key}Env`];
    if (file)
      out[key] = { configured: true, source: "file", ...(file.tail ? { tail: file.tail } : {}) };
    else if (typeof env === "string" && env && process.env[env])
      out[key] = { configured: true, source: "env" };
    else out[key] = { configured: false };
  }
  return out;
}

/** Non-secret profile values only (a hand-edited file could hold a secret field). */
function publicValues(
  values: Record<string, ProviderConfigurationValue>,
  type: Registration | undefined,
): Record<string, ProviderConfigurationValue> {
  const secret = new Set<string>([
    ...CREDENTIAL_KEYS,
    ...(type?.fields.filter((f) => f.kind === "secret").map((f) => f.key) ?? []),
  ]);
  return Object.fromEntries(Object.entries(values).filter(([key]) => !secret.has(key)));
}

function validValue(field: ProviderConfigurationField, value: unknown): boolean {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "select":
      return typeof value === "string" && (field.options ?? []).some((o) => o.value === value);
    case "url": {
      if (typeof value !== "string" || value.length > 2_000) return false;
      try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }
    case "text":
      return (
        (typeof value === "string" && value.length <= 2_000) ||
        (typeof value === "number" && Number.isFinite(value))
      );
    default:
      return false;
  }
}

export function registerProviderRoutes(
  router: Router,
  ctx: ManagementContext,
  recycler: WorkspaceRecycler,
): void {
  /** Any open app serves the provider types when no workspace is named. */
  const optionalApp = async (reference: string | null) =>
    reference ? workspaceApp(ctx.workspaces, reference) : ctx.workspaces.entries()[0];
  /** The global profile/credential files (the same ones every workspace app reads). */
  const store = () => new ProviderSettingsStore();

  async function profileInfo(
    name: string,
    types: Registration[],
  ): Promise<ProviderProfileInfo | undefined> {
    const settings = await store().load();
    const profile = settings.profiles[name];
    if (!profile) return undefined;
    const type = types.find((t) => t.id === profile.provider);
    return {
      name,
      provider: profile.provider,
      model: profile.model,
      values: publicValues(profile.values ?? {}, type),
      active: settings.active === name,
      credentials: await credentialStatus(store(), name, profile.values ?? {}, type),
    };
  }

  const profileParam = (value: string | undefined): string => {
    if (!value || !PROFILE_NAME.test(value))
      throw new HttpError("validation_failed", "Invalid profile name", { fields: ["profile"] });
    return value;
  };

  router.get("/api/providers", async ({ url }) => {
    const opened = await optionalApp(url.searchParams.get("workspace"));
    const settings = await store().load();
    const types = typesOf(opened);
    const profiles: ProviderProfileInfo[] = [];
    for (const name of Object.keys(settings.profiles).sort()) {
      const info = await profileInfo(name, types);
      if (info) profiles.push(info);
    }
    const info = opened?.app.providerInfo;
    const body: ProvidersOverview = {
      ...(settings.active ? { active: settings.active } : {}),
      profiles,
      types,
      ...(opened && info
        ? {
            current: {
              provider: info.id,
              model: opened.app.provider.model,
              ...(info.profileName ? { profile: info.profileName } : {}),
            },
          }
        : {}),
    };
    return { body };
  });

  router.put("/api/providers/:profile", async ({ req, params }) => {
    const name = profileParam(params.profile);
    const input = validate<{
      workspace: string;
      provider: string;
      values: Record<string, unknown>;
      model: string;
    }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
      provider: { check: is.nonEmpty(64), required: true },
      values: { check: is.object(), required: true },
      model: { check: is.nonEmpty(300), required: true },
    });
    const opened = await workspaceApp(ctx.workspaces, input.workspace);
    const types = typesOf(opened);
    const type = types.find((t) => t.id === input.provider);
    if (!type)
      throw new HttpError("validation_failed", "Unknown provider type", { fields: ["provider"] });
    const invalid: string[] = [];
    for (const [key, value] of Object.entries(input.values)) {
      const field = type.fields.find((f) => f.key === key);
      // Secrets go through the write-only credentials route, never into providers.json.
      if (!field || field.kind === "secret" || !validValue(field, value))
        invalid.push(`values.${key}`);
    }
    if (invalid.length)
      throw new HttpError("validation_failed", "Invalid profile values", { fields: invalid });
    await store().saveProfile(name, {
      provider: type.id,
      values: input.values as Record<string, ProviderConfigurationValue>,
      model: input.model.trim(),
    });
    recycler.announce(opened.id, ["models"]);
    return { body: await profileInfo(name, types) };
  });

  router.put("/api/providers/:profile/credentials", async ({ req, params }) => {
    const name = profileParam(params.profile);
    const input = validate<Partial<Record<(typeof CREDENTIAL_KEYS)[number], string>>>(
      await readJson(req),
      { apiKey: { check: secretValue }, bearerToken: { check: secretValue } },
    );
    const secrets = Object.fromEntries(
      Object.entries(input).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
    if (!Object.keys(secrets).length)
      throw new HttpError("validation_failed", "Send apiKey or bearerToken", {
        fields: ["apiKey", "bearerToken"],
      });
    if (!(await store().load()).profiles[name])
      throw new HttpError("not_found", "Provider profile not found");
    await store().setCredentials(name, secrets);
    const last = Object.values(secrets).at(-1) ?? "";
    const tail = maskSecret(last);
    return { body: { configured: true, ...(tail ? { tail } : {}) } };
  });

  router.delete("/api/providers/:profile/credentials", async ({ params }) => {
    const name = profileParam(params.profile);
    if (!(await store().deleteCredentials(name)))
      throw new HttpError("not_found", "No stored credentials for this profile");
    return { body: { configured: false } };
  });

  router.post("/api/providers/:profile/activate", async ({ req, params }) => {
    const name = profileParam(params.profile);
    const input = validate<{ workspace: string; model: string }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
      model: { check: is.nonEmpty(300), required: true },
    });
    const opened = await workspaceApp(ctx.workspaces, input.workspace);
    // P-01: the provider belongs to the workspace app; switching it under a run is refused.
    if (ctx.scheduler.busyWorkspace(opened.id))
      throw new HttpError(
        "runs_active",
        "Runs are active in this workspace; switch the provider when they finish",
      );
    if (!(await store().load()).profiles[name])
      throw new HttpError("not_found", "Provider profile not found");
    let changed: boolean;
    try {
      changed = await opened.app.activateProviderProfile(name, input.model.trim());
    } catch (error) {
      throw new HttpError(
        "provider_unavailable",
        error instanceof Error ? error.message : "The provider could not be activated",
      );
    }
    recycler.announce(opened.id, ["models"]);
    return { body: { changed } };
  });

  router.get("/api/models", async ({ url }) => {
    const opened = await workspaceApp(ctx.workspaces, url.searchParams.get("workspace"));
    let catalogs: ProviderModelsInfo[];
    try {
      catalogs = await opened.app.configuredProviderCatalogs(AbortSignal.timeout(15_000));
    } catch {
      throw new HttpError("provider_unavailable", "Configured providers could not be listed");
    }
    return {
      body: catalogs.map((c) => ({
        profile: c.profile,
        provider: c.provider,
        title: c.title,
        configuredModel: c.configuredModel,
        models: c.models,
        unavailable: c.unavailable,
      })),
    };
  });
}
