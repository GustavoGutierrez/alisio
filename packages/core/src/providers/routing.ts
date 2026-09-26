import type { AvailableProviderModel, ResolvedProviderModel } from "@alisio/sdk";

export interface ProviderModelCatalog {
  profile: string;
  provider: string;
  title: string;
  models: AvailableProviderModel["model"][];
  unavailable: boolean;
}

export function availableProviderModels(
  catalogs: readonly ProviderModelCatalog[],
): AvailableProviderModel[] {
  return catalogs
    .flatMap((catalog) =>
      catalog.unavailable
        ? []
        : catalog.models.map((model) => ({
            reference: `${catalog.provider}/${model.id}`,
            provider: catalog.provider,
            profile: catalog.profile,
            providerName: catalog.title,
            model,
          })),
    )
    .sort((a, b) => a.reference.localeCompare(b.reference));
}

const choices = (available: readonly AvailableProviderModel[]) =>
  [...new Set(available.map((entry) => entry.reference))].slice(0, 12).join(", ");

/** Resolves canonical provider/model selectors and safe, unique bare model ids. */
export function resolveProviderModel(
  catalogs: readonly ProviderModelCatalog[],
  input: string,
): ResolvedProviderModel {
  const reference = input.trim();
  if (!reference) throw new Error("Model selector must not be empty");
  const available = availableProviderModels(catalogs);
  const providers = [...new Set(catalogs.map((catalog) => catalog.provider))].sort(
    (a, b) => b.length - a.length,
  );
  const provider = providers.find((id) => reference.startsWith(`${id}/`));
  let matches: AvailableProviderModel[];
  if (provider) {
    const model = reference.slice(provider.length + 1);
    const matchingCatalogs = catalogs.filter((catalog) => catalog.provider === provider);
    matches = available.filter((entry) => entry.provider === provider && entry.model.id === model);
    if (!matches.length && matchingCatalogs.some((catalog) => catalog.unavailable))
      throw new Error(
        `Configured provider "${provider}" is unavailable. Reconnect it with /connect and retry ${reference}.`,
      );
  } else matches = available.filter((entry) => entry.model.id === reference);

  if (matches.length === 1) return matches[0] as ResolvedProviderModel;
  if (matches.length > 1)
    throw new Error(`Model selector "${reference}" is ambiguous. Use one of: ${choices(matches)}.`);
  const guidance = choices(available);
  throw new Error(
    `Model selector "${reference}" is not available from configured /connect profiles.${
      guidance
        ? ` Available provider/model choices: ${guidance}.`
        : " Configure a provider with /connect first."
    }`,
  );
}
