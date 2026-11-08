/**
 * Settings → Models: when a profile asks for a model. A provider type that signs in has no
 * account model list before the user is signed in, so a non-technical user is not asked to type
 * one: the profile is saved with the provider's own default model (`ProviderTypeInfo.defaultModel`,
 * never a name chosen by the web) and the list shows up after sign-in. Pure, no DOM.
 */
import type { CredentialStatus, ModelInfo } from "@alisio/sdk";
import { signInStatus } from "../../store/provider-signin.ts";

/** What the create/edit form saves as the model, and whether it must ask for it. */
export function formModelField(input: { signIn: boolean; model: string; defaultModel?: string }): {
  show: boolean;
  value: string;
} {
  const typed = input.model.trim();
  if (!input.signIn) return { show: true, value: input.model };
  // A sign-in provider with neither a model nor a default cannot be saved without one: ask.
  const value = typed || input.defaultModel?.trim() || "";
  return { show: value === "", value };
}

/** The model selector of a saved profile: hidden, a dropdown of the account's models, or a text input. */
export function activationModelField(input: {
  signIn: boolean;
  status: CredentialStatus | undefined;
  models: ModelInfo[];
}): "hidden" | "select" | "input" {
  if (input.signIn && signInStatus(input.status) !== "ok") return "hidden";
  return input.models.length ? "select" : "input";
}

/** The value a selector starts with: the current model, else the provider's default model. */
export function pickModel(input: {
  current: string;
  defaultModel?: string;
  models: ModelInfo[];
}): string {
  if (input.current.trim()) return input.current;
  const fallback = input.defaultModel?.trim() ?? "";
  if (!fallback) return "";
  // With a list, only a model the account really has can be preselected.
  return input.models.length && !input.models.some((m) => m.id === fallback) ? "" : fallback;
}
