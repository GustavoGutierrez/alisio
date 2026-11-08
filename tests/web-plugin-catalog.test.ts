/**
 * Web side of the plugin catalog and "Install from file": the pure model (search, filters, order,
 * grouping, pagination, install button and uninstall eligibility, the install flow reducer and the
 * phase stepper), the EN/ES strings and the tab list (walked as a VNode tree: no DOM here).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  actionState,
  ageLabel,
  type CatalogNav,
  type CatalogPluginView,
  catalogNav,
  DEFAULT_PLUGIN_ICON,
  DESCRIPTION_LIMIT,
  detailInfo,
  filterCatalog,
  groupByCategory,
  INITIAL_NAV,
  type InstalledPackageView,
  iconState,
  installedUpdateState,
  installOutcome,
  needsRestart,
  nextTab,
  normalize,
  orderByCategory,
  PAGE_SIZE,
  pageNumbers,
  paginate,
  resolvePluginIcon,
  rowAction,
  runUpdateAll,
  sortCatalog,
  tagCounts,
  truncateDescription,
  uninstallInfo,
  updatablePackages,
} from "../packages/web/src/components/settings/catalog-model.ts";
import { catalogStrings } from "../packages/web/src/components/settings/catalog-strings.ts";
import {
  acceptsFile,
  formatBytes,
  inspectVerdict,
  type JobStateView,
  type LocalFlow,
  type LocalInspectView,
  localReducer,
  PHASE_IDS,
  phaseSteps,
} from "../packages/web/src/components/settings/local-model.ts";

const pkg = (name: string, over: Partial<InstalledPackageView> = {}): InstalledPackageView => ({
  package: name,
  version: "1.0.0",
  pluginIds: [],
  removable: true,
  restartRequired: false,
  local: false,
  updateAvailable: false,
  updateCompatible: true,
  ...over,
});

const plugin = (slug: string, over: Partial<CatalogPluginView> = {}): CatalogPluginView => ({
  id: slug,
  slug,
  name: slug[0]?.toUpperCase() + slug.slice(1),
  package: `@alisio/plugin-${slug}`,
  version: "0.5.0",
  description: `The ${slug} plugin`,
  categories: ["tools"],
  tags: [slug],
  featured: false,
  updateAvailable: false,
  compatible: true,
  ...over,
});

describe("catalog search and filters", () => {
  const all = [
    plugin("brave", {
      name: "Brave Search",
      categories: ["search", "tools"],
      tags: ["grounding", "web"],
      description: "Búsqueda con contexto",
    }),
    plugin("atlassian", { tags: ["jira", "confluence"] }),
    plugin("icons", { categories: ["icon-theme"], tags: ["web"], package: "@x/material-icons" }),
  ];

  it("matches name, description, tags and package, accent-insensitive and word by word", () => {
    const find = (query: string) => filterCatalog(all, { query, tags: [] }).map((p) => p.slug);
    expect(find("brave")).toEqual(["brave"]);
    expect(find("busqueda")).toEqual(["brave"]);
    expect(find("jira")).toEqual(["atlassian"]);
    expect(find("material")).toEqual(["icons"]);
    expect(find("search grounding")).toEqual(["brave"]);
    expect(find("search jira")).toEqual([]);
    expect(find("  ")).toHaveLength(3);
    expect(normalize("Búsqueda")).toBe("busqueda");
  });

  it("filters by category and by every selected tag", () => {
    expect(filterCatalog(all, { query: "", category: "search", tags: [] })).toHaveLength(1);
    expect(filterCatalog(all, { query: "", tags: ["web"] }).map((p) => p.slug)).toEqual([
      "brave",
      "icons",
    ]);
    expect(
      filterCatalog(all, { query: "", tags: ["web", "grounding"] }).map((p) => p.slug),
    ).toEqual(["brave"]);
    expect(filterCatalog(all, { query: "jira", category: "search", tags: [] })).toEqual([]);
  });

  it("orders featured first then by name, and counts tags by frequency", () => {
    const sorted = sortCatalog([plugin("b"), plugin("c", { featured: true }), plugin("a")]);
    expect(sorted.map((p) => p.slug)).toEqual(["c", "a", "b"]);
    expect(tagCounts(all)).toEqual([
      { tag: "web", count: 2 },
      { tag: "confluence", count: 1 },
      { tag: "grounding", count: 1 },
      { tag: "jira", count: 1 },
    ]);
  });
});

describe("grouping and pagination", () => {
  const plugins = [
    plugin("a1", { categories: ["tools"] }),
    plugin("b1", { categories: ["search"] }),
    plugin("a2", { categories: ["tools"] }),
    plugin("c1", { categories: [] }),
  ];
  const categories = [{ id: "tools" }, { id: "search" }];

  it("orders by category rank and groups consecutive runs", () => {
    const ordered = orderByCategory(plugins, categories);
    expect(ordered.map((p) => p.slug)).toEqual(["a1", "a2", "b1", "c1"]);
    expect(groupByCategory(ordered).map((g) => [g.category, g.plugins.length])).toEqual([
      ["tools", 2],
      ["search", 1],
      ["other", 1],
    ]);
  });

  it("paginates 10 per page, clamps the page and reports the range", () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    expect(PAGE_SIZE).toBe(10);
    expect(paginate(items, 1)).toMatchObject({ page: 1, pages: 3, total: 23, from: 1, to: 10 });
    expect(paginate(items, 3)).toMatchObject({ from: 21, to: 23 });
    expect(paginate(items, 3).items).toEqual([20, 21, 22]);
    expect(paginate(items, 99).page).toBe(3);
    expect(paginate(items, -4).page).toBe(1);
    expect(paginate([], 1)).toMatchObject({ page: 1, pages: 1, total: 0, from: 0, to: 0 });
  });

  it("a grouped page slices the flat ordered list", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      plugin(`p${String(i).padStart(2, "0")}`, { categories: [i < 7 ? "tools" : "search"] }),
    );
    const flat = orderByCategory(many, categories);
    const second = paginate(flat, 2);
    expect(second.items).toHaveLength(2);
    expect(groupByCategory(second.items).map((g) => g.category)).toEqual(["search"]);
  });

  it("builds compact page number lists", () => {
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(1, 20)).toEqual([1, 2, "…", 19, 20]);
    expect(pageNumbers(10, 20)).toEqual([1, 2, "…", 9, 10, 11, "…", 19, 20]);
  });
});

describe("install button state", () => {
  it("maps a plugin to Install / Installing / Installed / Update / Incompatible", () => {
    expect(actionState(plugin("a"))).toEqual({ kind: "install", disabled: false, busy: false });
    expect(actionState(plugin("a"), "@alisio/plugin-a")).toMatchObject({
      kind: "installing",
      disabled: true,
    });
    expect(actionState(plugin("a", { installedVersion: "0.5.0" }))).toMatchObject({
      kind: "installed",
      disabled: true,
      reinstall: true,
    });
    // Same version but needs a newer SDK: nothing to reinstall.
    expect(
      actionState(plugin("a", { installedVersion: "0.5.0", compatible: false })).reinstall,
    ).toBe(false);
    expect(actionState(plugin("a", { installedVersion: "0.6.0" }))).toMatchObject({
      kind: "downgrade",
      disabled: false,
    });
    expect(
      actionState(plugin("a", { installedVersion: "0.4.0", updateAvailable: true })),
    ).toMatchObject({ kind: "update", disabled: false });
    expect(actionState(plugin("a", { compatible: false }))).toMatchObject({
      kind: "incompatible",
      disabled: true,
    });
    expect(
      actionState(
        plugin("a", { installedVersion: "0.4.0", updateAvailable: true, compatible: false }),
      ),
    ).toMatchObject({ kind: "incompatible", disabled: true });
  });

  it("disables the other buttons while one install runs", () => {
    expect(actionState(plugin("a"), "@alisio/plugin-b")).toEqual({
      kind: "install",
      disabled: true,
      busy: true,
    });
    expect(actionState(plugin("a", { installedVersion: "0.5.0" }), "x").kind).toBe("installed");
  });
});

describe("compact row description", () => {
  const long =
    "Read-first Jira, Confluence, and Agile tools with strict environment configuration and opt-in writes";

  it("keeps a short description untouched, with no ellipsis", () => {
    expect(truncateDescription("Short text")).toBe("Short text");
    const exact = "x".repeat(DESCRIPTION_LIMIT);
    expect(truncateDescription(exact)).toBe(exact);
  });

  it("cuts a long one at a word boundary, never past the shared limit, and adds one ellipsis", () => {
    const out = truncateDescription(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    // The cut falls between words: the next character of the source is a space.
    expect(long[out.length - 1]).toBe(" ");
    expect(out).not.toMatch(/[\s,;:.]…$/);
  });

  it("uses the same limit for every row and collapses whitespace", () => {
    expect(truncateDescription("a   b\n c")).toBe("a b c");
    for (const text of [long, `${long} ${long}`, "word ".repeat(40)])
      expect(truncateDescription(text).length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  it("hard-cuts a single long word and never splits a surrogate pair", () => {
    const out = truncateDescription("😀".repeat(80));
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).toMatch(/^(?:😀)+$/u);
  });
});

describe("row action by state", () => {
  it("maps each state to install / update / reinstall / downgrade with the install mode", () => {
    expect(rowAction(plugin("a"))).toEqual({ kind: "install", mode: "install", disabled: false });
    expect(rowAction(plugin("a", { installedVersion: "0.4.0", updateAvailable: true }))).toEqual({
      kind: "update",
      mode: "update",
      disabled: false,
    });
    expect(rowAction(plugin("a", { installedVersion: "0.5.0" }))).toEqual({
      kind: "reinstall",
      mode: "reinstall",
      disabled: false,
    });
    expect(rowAction(plugin("a", { installedVersion: "0.6.0" }))).toEqual({
      kind: "downgrade",
      mode: "downgrade",
      disabled: false,
    });
  });

  it("disables with a reason: incompatible, or busy while another install runs", () => {
    expect(rowAction(plugin("a", { compatible: false }))).toEqual({
      kind: "incompatible",
      disabled: true,
      reason: "incompatible",
    });
    // Same version installed but it needs a newer SDK: reinstalling is pointless.
    expect(rowAction(plugin("a", { installedVersion: "0.5.0", compatible: false }))).toEqual({
      kind: "reinstall",
      disabled: true,
      reason: "incompatible",
    });
    expect(rowAction(plugin("a"), "@alisio/plugin-b")).toEqual({
      kind: "install",
      mode: "install",
      disabled: true,
      reason: "busy",
    });
    expect(rowAction(plugin("a", { installedVersion: "0.5.0" }), "x")).toMatchObject({
      kind: "reinstall",
      disabled: true,
      reason: "busy",
    });
    expect(rowAction(plugin("a"), "@alisio/plugin-a")).toEqual({
      kind: "installing",
      disabled: true,
    });
  });
});

describe("plugin icons and the one default", () => {
  const catalogPlugins = [
    plugin("alpha", { icon: "/api/plugin-catalog/icons/alpha" }),
    plugin("noicon"),
  ];
  const installed = [
    pkg("@alisio/plugin-alpha", { icon: "/api/plugins/package-icon?package=own" }),
    pkg("@acme/shipped", { icon: "/api/plugins/package-icon?package=%40acme%2Fshipped" }),
    pkg("@acme/plain"),
  ];

  it("prefers the catalog icon, then the icon the installed package ships", () => {
    expect(resolvePluginIcon("@alisio/plugin-alpha", catalogPlugins, installed)).toBe(
      "/api/plugin-catalog/icons/alpha",
    );
    expect(resolvePluginIcon("@acme/shipped", catalogPlugins, installed)).toBe(
      "/api/plugins/package-icon?package=%40acme%2Fshipped",
    );
  });

  it("resolves nothing (so the default shows) without a catalog match or a packaged icon", () => {
    expect(resolvePluginIcon("@acme/plain", catalogPlugins, installed)).toBeUndefined();
    expect(resolvePluginIcon("@alisio/plugin-noicon", catalogPlugins, installed)).toBeUndefined();
    expect(resolvePluginIcon("@acme/unknown", catalogPlugins, installed)).toBeUndefined();
    expect(resolvePluginIcon(undefined, catalogPlugins, installed)).toBeUndefined();
    expect(resolvePluginIcon("x", undefined, undefined)).toBeUndefined();
  });

  it("the default is the one shipped image, served from the web root", () => {
    expect(DEFAULT_PLUGIN_ICON).toBe("/plugin-default.svg");
  });

  it("shows the default whenever there is no icon or the image failed to load", () => {
    expect(iconState(undefined, false)).toBe("default");
    expect(iconState("", false)).toBe("default");
    expect(iconState("/api/plugin-catalog/icons/alpha", true)).toBe("default");
    expect(iconState("/api/plugin-catalog/icons/alpha", false)).toBe("image");
  });

  it("the file-install preview uses the same rule: a file with no known icon gets the default", () => {
    const inspected = (name: string): LocalInspectView => ({
      package: name,
      compatible: true,
      isAlisioPlugin: true,
      reasons: [],
      lifecycleScripts: [],
      size: 10,
    });
    const iconFor = (info: LocalInspectView) =>
      resolvePluginIcon(info.package, catalogPlugins, installed);
    expect(iconState(iconFor(inspected("@acme/brand-new")), false)).toBe("default");
    expect(iconState(iconFor(inspected("@acme/shipped")), false)).toBe("image");
    expect(iconState(iconFor({ ...inspected("x"), package: undefined as never }), false)).toBe(
      "default",
    );
  });
});

describe("plugin detail model", () => {
  it("shows only the fields the catalog provides, in a fixed order", () => {
    const bare = detailInfo(plugin("a", { categories: [], tags: [] }));
    expect(bare.fields.map((f) => f.id)).toEqual(["version", "package"]);
    expect(bare.links).toEqual([]);
    const full = detailInfo(
      plugin("a", {
        installedVersion: "0.4.0",
        author: "Alisio",
        license: "MIT",
        sdk: ">=0.9.0 <0.12.0",
        publishedAt: "2026-11-08T02:52:23.558Z",
        categories: ["tools", "search"],
        tags: ["x", "y"],
        homepage: "https://example.test/home",
        repository: "https://example.test/repo",
        npmUrl: "https://www.npmjs.com/package/x",
      }),
    );
    expect(full.fields.map((f) => [f.id, f.value])).toEqual([
      ["version", "0.5.0"],
      ["installed", "0.4.0"],
      ["author", "Alisio"],
      ["license", "MIT"],
      ["categories", "tools, search"],
      ["tags", "x, y"],
      ["sdk", ">=0.9.0 <0.12.0"],
      ["package", "@alisio/plugin-a"],
      ["published", "2026-11-08"],
    ]);
    expect(full.links.map((l) => l.id)).toEqual(["npm", "repository", "homepage"]);
  });

  it("drops a homepage that repeats the repository and ignores an unparsable date", () => {
    const info = detailInfo(
      plugin("a", {
        homepage: "https://example.test/repo",
        repository: "https://example.test/repo",
        publishedAt: "yesterday",
      }),
    );
    expect(info.links.map((l) => l.id)).toEqual(["repository"]);
    expect(info.fields.some((f) => f.id === "published")).toBe(false);
  });
});

describe("catalog navigation: list state survives the detail view", () => {
  const apply = (state: CatalogNav, ...actions: Parameters<typeof catalogNav>[1][]) =>
    actions.reduce(catalogNav, state);

  it("starts on page 1 of an unfiltered list with no detail open", () => {
    expect(INITIAL_NAV).toEqual({
      list: { query: "", tags: [], group: false, page: 1 },
    });
  });

  it("opening a detail and going back keeps query, filters and page", () => {
    const before = apply(
      INITIAL_NAV,
      { type: "filter", patch: { query: "jira", category: "tools", tags: ["a"] } },
      { type: "page", page: 3 },
    );
    const open = apply(before, { type: "open", slug: "atlassian" });
    expect(open.detail).toBe("atlassian");
    expect(open.list).toEqual(before.list);
    const back = apply(open, { type: "back" });
    expect(back.detail).toBeUndefined();
    expect(back.list).toEqual(before.list);
    expect(back.list.page).toBe(3);
  });

  it("a filter change returns to page 1; a page change does not touch the filters", () => {
    const paged = apply(INITIAL_NAV, { type: "page", page: 4 });
    expect(paged.list.page).toBe(4);
    const filtered = apply(paged, { type: "filter", patch: { group: true } });
    expect(filtered.list).toMatchObject({ group: true, page: 1 });
    expect(apply(filtered, { type: "page", page: 2 }).list.group).toBe(true);
  });

  it("clear resets the filters but leaves grouping alone", () => {
    const s = apply(
      INITIAL_NAV,
      { type: "filter", patch: { query: "x", category: "tools", tags: ["a"], group: true } },
      { type: "clear" },
    );
    expect(s.list).toEqual({ query: "", tags: [], group: true, page: 1 });
  });
});

describe("uninstall eligibility", () => {
  const packages: InstalledPackageView[] = [
    pkg("@alisio/plugin-ica", { pluginIds: ["ica"], local: true }),
    pkg("ro", { pluginIds: ["ro-plugin"], removable: false }),
  ];
  it("allows only global npm packages and explains the rest", () => {
    expect(uninstallInfo({ id: "ica", builtin: false }, packages)).toEqual({
      removable: true,
      packageName: "@alisio/plugin-ica",
    });
    expect(uninstallInfo({ id: "memory", builtin: true }, packages)).toEqual({
      removable: false,
      reason: "builtin",
    });
    expect(uninstallInfo({ id: "local-thing", builtin: false }, packages)).toEqual({
      removable: false,
      reason: "notGlobal",
    });
    expect(uninstallInfo({ id: "ro-plugin", builtin: false }, packages)).toMatchObject({
      removable: false,
      reason: "readOnly",
    });
    expect(uninstallInfo({ id: "x", builtin: false }, undefined).reason).toBe("notGlobal");
  });
});

describe("updates of installed plugins", () => {
  it("classifies each package: update, blocked, current, local, unknown", () => {
    expect(installedUpdateState(pkg("a", { latestVersion: "2.0.0", updateAvailable: true }))).toBe(
      "update",
    );
    expect(
      installedUpdateState(
        pkg("a", { latestVersion: "2.0.0", updateAvailable: true, updateCompatible: false }),
      ),
    ).toBe("blocked");
    expect(installedUpdateState(pkg("a", { latestVersion: "1.0.0" }))).toBe("current");
    // Catalog older than installed: no update either.
    expect(installedUpdateState(pkg("a", { latestVersion: "0.9.0" }))).toBe("current");
    expect(installedUpdateState(pkg("a", { local: true }))).toBe("local");
    expect(installedUpdateState(pkg("a"))).toBe("unknown");
    expect(installedUpdateState(undefined)).toBe("unknown");
  });

  it("counts compatible updates only, and finds a pending restart", () => {
    const list = [
      pkg("a", { updateAvailable: true, latestVersion: "2.0.0" }),
      pkg("b", { updateAvailable: true, updateCompatible: false, latestVersion: "2.0.0" }),
      pkg("c", { restartRequired: true }),
    ];
    expect(updatablePackages(list).map((p) => p.package)).toEqual(["a"]);
    expect(needsRestart(list)).toBe(true);
    expect(needsRestart([pkg("a")])).toBe(false);
    expect(updatablePackages(undefined)).toEqual([]);
  });

  it("Update all calls the combined endpoint ONCE with every package and maps the results", async () => {
    const calls: string[][] = [];
    const seen: string[][] = [];
    const summary = await runUpdateAll(
      ["a", "b", "c"],
      async (names) => {
        calls.push(names);
        return {
          updated: [
            { package: "a", installedVersion: "2.0.0", restartRequired: false },
            {
              package: "b",
              installedVersion: "2.1.0",
              previousVersion: "1.0.0",
              restartRequired: true,
            },
            { package: "c", installedVersion: "2.0.0", restartRequired: false },
          ],
          restartPending: false,
        };
      },
      (items) => seen.push(items.map((i) => `${i.package}:${i.status}`)),
    );
    expect(calls).toEqual([["a", "b", "c"]]);
    expect(summary).toMatchObject({ updated: 3, failed: 0, restartRequired: true });
    expect(summary.items[1]).toEqual({
      package: "b",
      status: "done",
      version: "2.1.0",
      restartRequired: true,
    });
    expect(seen[0]).toEqual(["a:pending", "b:pending", "c:pending"]);
    expect(seen[1]).toEqual(["a:running", "b:running", "c:running"]);
    expect(seen.at(-1)).toEqual(["a:done", "b:done", "c:done"]);
  });

  it("Update all marks every package failed with the shared error when the call fails", async () => {
    const summary = await runUpdateAll(["a", "b"], async () => {
      throw new Error("npm exploded");
    });
    expect(summary).toMatchObject({ updated: 0, failed: 2, restartRequired: false });
    expect(summary.items).toEqual([
      { package: "a", status: "failed", error: "npm exploded" },
      { package: "b", status: "failed", error: "npm exploded" },
    ]);
  });

  it("Update all flags a requested package the server did not update and lists extras", async () => {
    const summary = await runUpdateAll(["a", "b"], async () => ({
      updated: [
        { package: "a", installedVersion: "2.0.0", restartRequired: false },
        { package: "z", installedVersion: "3.0.0", restartRequired: false },
      ],
      restartPending: false,
    }));
    expect(summary.items.map((i) => `${i.package}:${i.status}`)).toEqual([
      "a:done",
      "b:failed",
      "z:done",
    ]);
    expect(summary).toMatchObject({ updated: 2, failed: 1 });
  });

  it("Update all with nothing to update never calls the server", async () => {
    let called = 0;
    const summary = await runUpdateAll([], async () => {
      called++;
      return { updated: [], restartPending: false };
    });
    expect(called).toBe(0);
    expect(summary.updated).toBe(0);
  });
});

describe("install outcome message", () => {
  const base = {
    package: "p",
    installedVersion: "2.0.0",
    alreadyInstalled: false,
    updated: false,
    restartPending: false,
    restartRequired: false,
  };
  it("picks the message for each way an install can end", () => {
    expect(installOutcome("P", base).key).toBe("install.done");
    expect(installOutcome("P", { ...base, alreadyInstalled: true }).key).toBe("install.already");
    expect(
      installOutcome("P", {
        ...base,
        alreadyInstalled: true,
        updated: true,
        previousVersion: "1.0.0",
      }),
    ).toMatchObject({ key: "install.updatedFrom", params: { from: "1.0.0", version: "2.0.0" } });
    expect(installOutcome("P", { ...base, updated: true, previousVersion: "2.0.0" }).key).toBe(
      "install.reinstalled",
    );
    expect(installOutcome("P", { ...base, restartPending: true }).key).toBe("install.deferred");
    // A restart outranks everything: the old code is still running.
    expect(
      installOutcome("P", { ...base, updated: true, restartPending: true, restartRequired: true })
        .key,
    ).toBe("install.restartNeeded");
  });
});

describe("co-updated plugins after a single update", () => {
  const base = {
    package: "@alisio/plugin-alpha",
    installedVersion: "0.6.0",
    alreadyInstalled: true,
    updated: true,
    previousVersion: "0.5.0",
    restartPending: false,
    restartRequired: false,
  };
  it("adds a note naming the other updated plugins, whatever the main message is", () => {
    const alsoUpdated = [
      { package: "@alisio/plugin-beta", installedVersion: "0.6.0", previousVersion: "0.5.0" },
      { package: "@alisio/plugin-gamma", installedVersion: "1.2.0" },
    ];
    expect(installOutcome("Alpha", { ...base, alsoUpdated })).toMatchObject({
      key: "install.updatedFrom",
      note: {
        key: "install.alsoUpdated",
        params: { others: "@alisio/plugin-beta v0.6.0, @alisio/plugin-gamma v1.2.0" },
      },
    });
    expect(installOutcome("Alpha", { ...base, restartRequired: true, alsoUpdated }).key).toBe(
      "install.restartNeeded",
    );
    expect(
      installOutcome("Alpha", { ...base, restartRequired: true, alsoUpdated }).note,
    ).toBeDefined();
  });
  it("has no note when nobody else was updated", () => {
    expect(installOutcome("Alpha", base).note).toBeUndefined();
    expect(installOutcome("Alpha", { ...base, alsoUpdated: [] }).note).toBeUndefined();
  });
});

describe("age and tabs", () => {
  it("formats the age of the last check", () => {
    const now = 10_000_000;
    expect(ageLabel(now - 5_000, now, "en")).toBe("now");
    expect(ageLabel(now - 3 * 60_000, now, "en")).toBe("3 minutes ago");
    expect(ageLabel(now - 5 * 3_600_000, now, "en")).toBe("5 hours ago");
    expect(ageLabel(now - 2 * 86_400_000, now, "en")).toBe("2 days ago");
    expect(ageLabel(now - 3 * 60_000, now, "es")).toContain("3");
  });

  it("moves between tabs with the arrow keys, Home and End", () => {
    const ids = ["configuration", "list", "catalog", "file"] as const;
    expect(nextTab(ids, "configuration", "ArrowRight")).toBe("list");
    expect(nextTab(ids, "file", "ArrowRight")).toBe("configuration");
    expect(nextTab(ids, "configuration", "ArrowLeft")).toBe("file");
    expect(nextTab(ids, "list", "Home")).toBe("configuration");
    expect(nextTab(ids, "list", "End")).toBe("file");
    expect(nextTab(ids, "list", "Enter")).toBeUndefined();
  });
});

// ---- Tabs: rendered ----------------------------------------------------------------------------

interface VNode {
  type: unknown;
  props: Record<string, unknown>;
}
const isNode = (value: unknown): value is VNode =>
  !!value && typeof value === "object" && "props" in value;
function walk(node: unknown, visit: (n: VNode) => void): void {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (!isNode(node)) return;
  visit(node);
  walk(node.props.children, visit);
}

describe("PluginTabs", () => {
  let PluginTabs: (props: Record<string, unknown>) => VNode;
  beforeAll(async () => {
    const path = "../packages/web/src/components/settings/PluginTabs.tsx";
    PluginTabs = ((await import(/* @vite-ignore */ path)) as { PluginTabs: typeof PluginTabs })
      .PluginTabs;
  });

  const tabs = [
    { id: "configuration", label: "Plugin configuration" },
    { id: "list", label: "Installed plugins" },
    { id: "catalog", label: "Plugin catalog" },
    { id: "file", label: "Install from file" },
  ];

  it("renders an accessible tab list with a roving tabindex", () => {
    const onSelect = vi.fn();
    const root = PluginTabs({ tabs, active: "catalog", label: "Plugin sections", onSelect });
    expect(root.props.role).toBe("tablist");
    expect(root.props["aria-label"]).toBe("Plugin sections");
    const buttons: VNode[] = [];
    walk(root, (n) => {
      if (n.props.role === "tab") buttons.push(n);
    });
    expect(buttons.map((b) => b.props.children)).toEqual(tabs.map((t) => t.label));
    expect(buttons.map((b) => b.props["aria-selected"])).toEqual([false, false, true, false]);
    expect(buttons.map((b) => b.props.tabIndex)).toEqual([-1, -1, 0, -1]);
    expect(buttons[2]?.props["aria-controls"]).toBe("plugins-panel-catalog");
  });

  it("selects on click and on arrow keys", () => {
    const onSelect = vi.fn();
    const root = PluginTabs({ tabs, active: "list", label: "x", onSelect });
    const buttons: VNode[] = [];
    walk(root, (n) => {
      if (n.props.role === "tab") buttons.push(n);
    });
    (buttons[2]?.props.onClick as () => void)();
    expect(onSelect).toHaveBeenLastCalledWith("catalog");
    const preventDefault = vi.fn();
    vi.stubGlobal("document", { getElementById: () => ({ focus() {} }) });
    (buttons[1]?.props.onKeyDown as (e: unknown) => void)({ key: "ArrowRight", preventDefault });
    expect(onSelect).toHaveBeenLastCalledWith("catalog");
    expect(preventDefault).toHaveBeenCalled();
    (buttons[1]?.props.onKeyDown as (e: unknown) => void)({ key: "a", preventDefault });
    expect(onSelect).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

// ---- Strings -------------------------------------------------------------------------------------

describe("catalog strings", () => {
  it("English and Spanish have the same keys and placeholders", () => {
    const { en, es } = catalogStrings;
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>)
      expect(holes(es[key]), key).toEqual(holes(en[key]));
  });
});

// ---- Install from file ---------------------------------------------------------------------------

const info = (over: Partial<LocalInspectView> = {}): LocalInspectView => ({
  stagingId: "11111111-1111-4111-8111-111111111111",
  package: "@alisio/plugin-ica",
  version: "0.1.0",
  compatible: true,
  isAlisioPlugin: true,
  reasons: [],
  lifecycleScripts: [],
  size: 2048,
  ...over,
});

describe("install from file model", () => {
  it("accepts .tgz and .tar.gz only", () => {
    expect(acceptsFile("a.tgz")).toBe(true);
    expect(acceptsFile("A-1.0.0.TAR.GZ")).toBe(true);
    expect(acceptsFile("a.zip")).toBe(false);
    expect(acceptsFile("tgz")).toBe(false);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("derives the verdict: SDK mismatch and lifecycle scripts warn, an invalid file blocks", () => {
    expect(inspectVerdict(info())).toEqual({ canInstall: true, warnings: [] });
    expect(
      inspectVerdict(info({ compatible: false, lifecycleScripts: ["postinstall"] })).warnings,
    ).toEqual(["sdk", "lifecycle"]);
    expect(inspectVerdict(info({ compatible: false })).canInstall).toBe(true);
    expect(inspectVerdict(info({ isAlisioPlugin: false, stagingId: undefined })).canInstall).toBe(
      false,
    );
    expect(
      inspectVerdict(info({ installed: { version: "0.0.9", relation: "update" } })).existing,
    ).toEqual({ version: "0.0.9", relation: "update" });
    expect(
      inspectVerdict(info({ installed: { version: "0.1.0", relation: "same" } })).existing
        ?.relation,
    ).toBe("same");
    expect(
      inspectVerdict(info({ installed: { version: "0.2.0", relation: "downgrade" } })).existing
        ?.relation,
    ).toBe("downgrade");
    // "Update from file" scoped to a package warns when the file is another package.
    expect(inspectVerdict(info(), "@alisio/plugin-ica").scopeMismatch).toBeUndefined();
    expect(inspectVerdict(info(), "@alisio/plugin-other")).toMatchObject({
      scopeMismatch: true,
      canInstall: true,
    });
  });

  const job = (statuses: string[], extra: Partial<JobStateView> = {}): JobStateView => ({
    phases: PHASE_IDS.map((id, i) => ({
      id,
      status: (statuses[i] ?? "pending") as "pending",
    })),
    done: false,
    ...extra,
  });

  it("walks pick -> inspect -> install -> done", () => {
    let flow: LocalFlow = { step: "idle" };
    flow = localReducer(flow, { type: "pick", fileName: "ica.tgz" });
    expect(flow.step).toBe("inspecting");
    flow = localReducer(flow, { type: "inspected", info: info() });
    expect(flow.step).toBe("inspected");
    flow = localReducer(flow, { type: "start" });
    expect(flow.step).toBe("installing");
    flow = localReducer(flow, {
      type: "progress",
      job: job(["done", "done", "running"], { phase: "copying" }),
    });
    expect(flow).toMatchObject({ step: "installing", job: { phase: "copying" } });
    const finished = job(Array(7).fill("done"), {
      done: true,
      result: {
        package: "@alisio/plugin-ica",
        installedVersion: "0.1.0",
        alreadyInstalled: false,
        updated: false,
        restartPending: false,
        restartRequired: false,
      },
    });
    flow = localReducer(flow, { type: "progress", job: finished });
    expect(flow.step).toBe("done");
    expect(localReducer(flow, { type: "reset" })).toEqual({ step: "idle" });
  });

  it("an invalid file cannot start an install; a failed job keeps the npm tail", () => {
    const bad = localReducer(localReducer({ step: "idle" }, { type: "pick", fileName: "x.tgz" }), {
      type: "inspected",
      info: info({ isAlisioPlugin: false, stagingId: undefined }),
    });
    expect(localReducer(bad, { type: "start" })).toBe(bad);
    let flow: LocalFlow = localReducer(
      localReducer(localReducer({ step: "idle" }, { type: "pick", fileName: "x.tgz" }), {
        type: "inspected",
        info: info(),
      }),
      { type: "start" },
    );
    flow = localReducer(flow, {
      type: "progress",
      job: job(["done", "done", "done", "failed"], {
        done: true,
        error: "npm install failed",
        logTail: "E404",
      }),
    });
    expect(flow).toMatchObject({ step: "failed", error: "npm install failed", logTail: "E404" });
  });

  it("ignores a new pick while installing, and turns a request error into a failure", () => {
    const installing = localReducer(
      localReducer(localReducer({ step: "idle" }, { type: "pick", fileName: "x.tgz" }), {
        type: "inspected",
        info: info(),
      }),
      { type: "start" },
    );
    expect(localReducer(installing, { type: "pick", fileName: "y.tgz" })).toBe(installing);
    expect(localReducer(installing, { type: "error", message: "offline" })).toMatchObject({
      step: "failed",
      error: "offline",
    });
  });

  it("the stepper shows the upload running before the first poll, then the job's phases", () => {
    expect(phaseSteps(undefined).map((s) => s.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(phaseSteps(job(["done", "done", "done", "running"])).map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "running",
      "pending",
      "pending",
      "pending",
    ]);
    expect(PHASE_IDS).toEqual([
      "uploading",
      "validating",
      "copying",
      "installing",
      "registering",
      "reloading",
      "cleanup",
    ]);
  });
});
