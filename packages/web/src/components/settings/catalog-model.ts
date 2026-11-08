/**
 * Pure model of the plugin catalog tab: wire types (local to the web, the SDK does not carry
 * them), search and filters, ordering, grouping, pagination, the install button state and the
 * uninstall eligibility of an installed plugin. No DOM, no signals: components stay thin.
 */
import type { PluginInfo } from "@alisio/sdk";

export const PAGE_SIZE = 10;

export interface CatalogPluginView {
  id: string;
  slug: string;
  name: string;
  package: string;
  version: string;
  description: string;
  categories: string[];
  tags: string[];
  sdk?: string;
  author?: string;
  license?: string;
  homepage?: string;
  npmUrl?: string;
  repository?: string;
  publishedAt?: string;
  featured: boolean;
  /** Same-origin cover URL; absent when the catalog has none. */
  cover?: string;
  installedVersion?: string;
  updateAvailable: boolean;
  compatible: boolean;
}

export interface CatalogMetaView {
  checkedAt: number;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  offline: boolean;
  error?: string;
}

/** `GET /api/plugin-catalog`. */
export interface PluginCatalogView {
  catalog: {
    generatedAt?: string;
    categories: Array<{ id: string; count: number }>;
    plugins: CatalogPluginView[];
  };
  meta: CatalogMetaView;
  installed: Array<{ package: string; version: string }>;
  sdkVersion?: string;
}

/** `GET /api/plugins/packages`. */
export interface InstalledPackageView {
  package: string;
  version: string;
  pluginIds: string[];
  removable: boolean;
  /** Updated on disk while the old code still runs: needs a restart. */
  restartRequired: boolean;
  /** Installed from a local file: no remote source to check. */
  local: boolean;
  latestVersion?: string;
  updateAvailable: boolean;
  /** False when the newer version needs a newer SDK than this Alisio has. */
  updateCompatible: boolean;
}

/** `POST /api/plugins/install` (and the result of a local install job). */
export interface InstallResultView {
  package: string;
  installedVersion: string;
  alreadyInstalled: boolean;
  updated: boolean;
  previousVersion?: string;
  restartPending: boolean;
  restartRequired: boolean;
  /** Other plugins updated in the same npm call because this one conflicted with them. */
  alsoUpdated?: Array<{ package: string; installedVersion: string; previousVersion?: string }>;
}

/** `POST /api/plugins/update-all`: every outdated plugin updated in one npm call. */
export interface UpdateAllResultView {
  updated: Array<{
    package: string;
    installedVersion: string;
    previousVersion?: string;
    restartRequired: boolean;
  }>;
  restartPending: boolean;
}

/** `DELETE /api/plugins/package/:name`. */
export interface UninstallResultView {
  package: string;
  removed: boolean;
  restartPending: boolean;
}

// ---- Search and filters ------------------------------------------------------------------------

/** Lowercase, accent-insensitive text for matching. */
export const normalize = (text: string): string =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export interface CatalogFilter {
  query: string;
  category?: string;
  /** Every selected tag must be present (AND). */
  tags: string[];
}

const haystack = (plugin: CatalogPluginView): string =>
  normalize([plugin.name, plugin.description, plugin.package, plugin.id, ...plugin.tags].join(" "));

/** Free text over name, description, tags and package (every word must match), plus the chips. */
export function filterCatalog(
  plugins: CatalogPluginView[],
  filter: CatalogFilter,
): CatalogPluginView[] {
  const words = normalize(filter.query).split(/\s+/).filter(Boolean);
  return plugins.filter((plugin) => {
    if (filter.category && !plugin.categories.includes(filter.category)) return false;
    if (!filter.tags.every((tag) => plugin.tags.includes(tag))) return false;
    if (!words.length) return true;
    const text = haystack(plugin);
    return words.every((word) => text.includes(word));
  });
}

/** Featured first, then by name: a stable order for the flat list. */
export function sortCatalog(plugins: CatalogPluginView[]): CatalogPluginView[] {
  return [...plugins].sort(
    (a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name),
  );
}

export const primaryCategory = (plugin: CatalogPluginView): string =>
  plugin.categories[0] ?? "other";

/**
 * The flat list ordered for the group-by-category view: by the catalog's category order (largest
 * first), then by the usual order. Pagination then slices this one list.
 */
export function orderByCategory(
  plugins: CatalogPluginView[],
  categories: Array<{ id: string }>,
): CatalogPluginView[] {
  const rank = new Map(categories.map((category, index) => [category.id, index]));
  const of = (plugin: CatalogPluginView) => rank.get(primaryCategory(plugin)) ?? categories.length;
  return sortCatalog(plugins).sort((a, b) => of(a) - of(b));
}

/** Consecutive runs of the same primary category (the page slice is already ordered). */
export function groupByCategory(
  plugins: CatalogPluginView[],
): Array<{ category: string; plugins: CatalogPluginView[] }> {
  const groups: Array<{ category: string; plugins: CatalogPluginView[] }> = [];
  for (const plugin of plugins) {
    const category = primaryCategory(plugin);
    const last = groups.at(-1);
    if (last && last.category === category) last.plugins.push(plugin);
    else groups.push({ category, plugins: [plugin] });
  }
  return groups;
}

/** Tags by frequency (then alphabetically), for the chip row. */
export function tagCounts(plugins: CatalogPluginView[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const plugin of plugins)
    for (const tag of plugin.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---- Pagination ----------------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  /** The current page, clamped into range (1-based). */
  page: number;
  pages: number;
  total: number;
  /** 1-based positions of the first and last item on the page (0 when empty). */
  from: number;
  to: number;
}

export function paginate<T>(items: T[], page: number, size = PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: current,
    pages,
    total: items.length,
    from: slice.length ? start + 1 : 0,
    to: start + slice.length,
  };
}

/** Page numbers to show: first, last, the current one and its neighbours, with "…" gaps. */
export function pageNumbers(page: number, pages: number): Array<number | "…"> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const wanted = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1]);
  const numbers = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  for (const n of numbers) {
    const previous = out.at(-1);
    if (typeof previous === "number" && n - previous > 1) out.push("…");
    out.push(n);
  }
  return out;
}

// ---- Install / uninstall states ----------------------------------------------------------------

export type ActionKind =
  | "install"
  | "installing"
  | "installed"
  | "update"
  | "downgrade"
  | "incompatible";

export interface ActionState {
  kind: ActionKind;
  /** Not clickable. `busy` means another install or uninstall is running. */
  disabled: boolean;
  busy: boolean;
  /** The same version is installed: offer a secondary "Reinstall". */
  reinstall?: boolean;
}

/**
 * The button of a catalog card. Only one install or uninstall runs at a time (the server shares
 * one npm prefix), so every other button is disabled while one runs.
 */
export function actionState(plugin: CatalogPluginView, working?: string): ActionState {
  if (working === plugin.package) return { kind: "installing", disabled: true, busy: false };
  const busy = working !== undefined;
  const installed = plugin.installedVersion;
  if (installed !== undefined && installed === plugin.version)
    return { kind: "installed", disabled: true, busy, reinstall: plugin.compatible };
  if (!plugin.compatible) return { kind: "incompatible", disabled: true, busy };
  if (installed === undefined) return { kind: "install", disabled: busy, busy };
  // A different version is installed: a higher catalog version updates, a lower one downgrades.
  return { kind: plugin.updateAvailable ? "update" : "downgrade", disabled: busy, busy };
}

export type UninstallReason = "builtin" | "notGlobal" | "readOnly";

export interface UninstallInfo {
  removable: boolean;
  packageName?: string;
  reason?: UninstallReason;
}

/**
 * Whether an installed plugin can be uninstalled from the web: only npm packages installed into
 * the global plugins directory. Built-ins and project or local plugins say why they cannot.
 */
export function uninstallInfo(
  plugin: Pick<PluginInfo, "id" | "builtin">,
  packages: InstalledPackageView[] | undefined,
): UninstallInfo {
  if (plugin.builtin) return { removable: false, reason: "builtin" };
  const owner = packages?.find((item) => item.pluginIds.includes(plugin.id));
  if (!owner) return { removable: false, reason: "notGlobal" };
  if (!owner.removable) return { removable: false, packageName: owner.package, reason: "readOnly" };
  return { removable: true, packageName: owner.package };
}

// ---- Time ----------------------------------------------------------------------------------------

/** "3 minutes ago" in the given language; "now" under half a minute. */
export function ageLabel(then: number, now: number, language: string): string {
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 30) return formatter.format(0, "second");
  if (seconds < 3600) return formatter.format(-Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return formatter.format(-Math.round(seconds / 3600), "hour");
  return formatter.format(-Math.round(seconds / 86_400), "day");
}

// ---- Tabs ----------------------------------------------------------------------------------------

/** The tab a key moves to (arrow keys wrap, Home and End jump); `undefined` for other keys. */
export function nextTab<T extends string>(
  ids: readonly T[],
  current: T,
  key: string,
): T | undefined {
  const index = ids.indexOf(current);
  if (index < 0 || ids.length === 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return ids[(index + 1) % ids.length];
    case "ArrowLeft":
      return ids[(index - 1 + ids.length) % ids.length];
    case "Home":
      return ids[0];
    case "End":
      return ids.at(-1);
    default:
      return undefined;
  }
}

// ---- Updates of installed plugins -----------------------------------------------------------------

export type InstalledUpdate = "local" | "update" | "blocked" | "current" | "unknown";

/** What the Installed tab shows for a package: an update, a blocked update, a local file... */
export function installedUpdateState(pkg: InstalledPackageView | undefined): InstalledUpdate {
  if (!pkg) return "unknown";
  if (pkg.local) return "local";
  if (pkg.updateAvailable) return pkg.updateCompatible ? "update" : "blocked";
  return pkg.latestVersion ? "current" : "unknown";
}

/** Packages "Update all" will run (compatible updates only). */
export const updatablePackages = (packages: InstalledPackageView[] | undefined) =>
  (packages ?? []).filter((pkg) => installedUpdateState(pkg) === "update");

export const needsRestart = (packages: InstalledPackageView[] | undefined): boolean =>
  (packages ?? []).some((pkg) => pkg.restartRequired);

export type ItemOutcome =
  | { package: string; status: "running" | "pending" }
  | { package: string; status: "done"; version: string; restartRequired: boolean }
  | { package: string; status: "failed"; error: string };

export interface UpdateAllSummary {
  updated: number;
  failed: number;
  restartRequired: boolean;
  items: ItemOutcome[];
}

/**
 * Updates every package with ONE call (`update` is `POST /api/plugins/update-all`): plugins share
 * one npm prefix and peer ranges, and only a single combined install lets npm resolve them
 * together. A failed call fails every package with the same error; a package the server did not
 * report as updated is flagged, and extra packages it did update are listed. `onProgress` sees
 * every state change.
 */
export async function runUpdateAll(
  packages: string[],
  update: (names: string[]) => Promise<UpdateAllResultView>,
  onProgress?: (items: ItemOutcome[]) => void,
): Promise<UpdateAllSummary> {
  let items: ItemOutcome[] = packages.map((name) => ({ package: name, status: "pending" }));
  const publish = () => onProgress?.(items.map((item) => ({ ...item })));
  publish();
  if (packages.length > 0) {
    items = packages.map((name) => ({ package: name, status: "running" }));
    publish();
    try {
      const result = await update(packages);
      const byName = new Map(result.updated.map((entry) => [entry.package, entry]));
      const outcome = (name: string): ItemOutcome => {
        const entry = byName.get(name);
        return entry
          ? {
              package: name,
              status: "done",
              version: entry.installedVersion,
              restartRequired: entry.restartRequired,
            }
          : { package: name, status: "failed", error: "No update was applied" };
      };
      items = [
        ...packages.map(outcome),
        ...result.updated
          .filter((entry) => !packages.includes(entry.package))
          .map((e) => outcome(e.package)),
      ];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      items = packages.map((name) => ({ package: name, status: "failed", error: message }));
    }
    publish();
  }
  return {
    updated: items.filter((item) => item.status === "done").length,
    failed: items.filter((item) => item.status === "failed").length,
    restartRequired: items.some((item) => item.status === "done" && item.restartRequired),
    items,
  };
}

// ---- Install outcome ------------------------------------------------------------------------------

/** What to tell the user after an install, update, reinstall or downgrade finished. */
export function installOutcome(
  name: string,
  result: InstallResultView,
): {
  key:
    | "install.restartNeeded"
    | "install.deferred"
    | "install.reinstalled"
    | "install.updatedFrom"
    | "install.already"
    | "install.done";
  params: Record<string, string>;
  /** Extra sentence: which other plugins were updated in the same call. */
  note?: { key: "install.alsoUpdated"; params: { others: string } };
} {
  const params = {
    name,
    version: result.installedVersion,
    from: result.previousVersion ?? "",
  };
  const others = result.alsoUpdated ?? [];
  const note = others.length
    ? {
        note: {
          key: "install.alsoUpdated" as const,
          params: { others: others.map((o) => `${o.package} v${o.installedVersion}`).join(", ") },
        },
      }
    : {};
  if (result.restartRequired) return { key: "install.restartNeeded", params, ...note };
  if (result.restartPending) return { key: "install.deferred", params, ...note };
  if (result.updated)
    return {
      key:
        result.previousVersion === result.installedVersion
          ? "install.reinstalled"
          : "install.updatedFrom",
      params,
      ...note,
    };
  if (result.alreadyInstalled) return { key: "install.already", params, ...note };
  return { key: "install.done", params, ...note };
}

export type InstallMode = "install" | "update" | "reinstall" | "downgrade";

/** What a click on a catalog action does to the installed package. */
export interface InstallTarget {
  package: string;
  name: string;
  /** The version to install. */
  version: string;
  installedVersion?: string;
  mode: InstallMode;
}
