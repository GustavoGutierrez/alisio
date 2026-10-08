/**
 * Icon theme store: the VSCode resolution order (exact name, extension chain, default), expanded
 * folders, the fallbacks when no theme is active or a key is missing, and the load-once contract.
 */
import { describe, expect, it } from "vitest";
import {
  type IconThemeApi,
  type IconThemeManifest,
  iconFor,
  iconThemeActive,
  iconThemeError,
  iconThemeManifest,
  iconThemeThemes,
  loadIconTheme,
  resetIconTheme,
  resolveIcon,
} from "../packages/web/src/store/icon-theme.ts";

const manifest: IconThemeManifest = {
  iconDefinitions: {
    _file: { iconPath: "./file.svg" },
    _ts: { iconPath: "./file_type_ts.svg" },
    _dts: { iconPath: "./file_type_dts.svg" },
    _folder: { iconPath: "./folder.svg" },
    _folderOpen: { iconPath: "./folder-open.svg" },
    _src: { iconPath: "./folder_src.svg" },
    _srcOpen: { iconPath: "./folder_src-open.svg" },
    _pkg: { iconPath: "./file_type_npm.svg" },
  },
  file: "_file",
  folder: "_folder",
  folderExpanded: "_folderOpen",
  fileNames: { "package.json": "_pkg" },
  fileExtensions: { ts: "_ts", "d.ts": "_dts" },
  folderNames: { src: "_src" },
  folderNamesExpanded: { src: "_srcOpen" },
};

const fakeApi = (
  catalog: { active: string; themes: Array<{ id: string; label: string }> },
  fetched: IconThemeManifest,
  calls: string[],
): IconThemeApi => ({
  iconThemes: async (workspace) => {
    calls.push(`catalog:${workspace}`);
    return catalog;
  },
  iconThemeManifest: async (workspace) => {
    calls.push(`manifest:${workspace}`);
    return fetched;
  },
});

describe("icon theme resolution", () => {
  it("resolves a file by exact name before trying its extension", () => {
    expect(resolveIcon(manifest, "package.json")).toBe("file_type_npm.svg");
  });

  it("tries the full extension chain, longest first", () => {
    expect(resolveIcon(manifest, "foo.d.ts")).toBe("file_type_dts.svg");
    expect(resolveIcon(manifest, "foo.ts")).toBe("file_type_ts.svg");
  });

  it("falls back to the default file icon for an unknown extension or no extension", () => {
    expect(resolveIcon(manifest, "README")).toBe("file.svg");
    expect(resolveIcon(manifest, "notes.log")).toBe("file.svg");
  });

  it("resolves folder names, the expanded variant and the folder defaults", () => {
    expect(resolveIcon(manifest, "src", { dir: true })).toBe("folder_src.svg");
    expect(resolveIcon(manifest, "src", { dir: true, expanded: true })).toBe("folder_src-open.svg");
    expect(resolveIcon(manifest, "lib", { dir: true })).toBe("folder.svg");
    expect(resolveIcon(manifest, "lib", { dir: true, expanded: true })).toBe("folder-open.svg");
  });

  it("returns undefined when the manifest lacks the icon or there is no manifest", () => {
    expect(resolveIcon({ iconDefinitions: {} }, "a.ts")).toBeUndefined();
    expect(
      resolveIcon({ iconDefinitions: { _x: { iconPath: "./x.svg" } } }, "a.ts"),
    ).toBeUndefined();
    expect(resolveIcon(undefined, "a.ts")).toBeUndefined();
  });
});

describe("icon theme store", () => {
  it("fetches the catalog and manifest once per workspace and exposes them", async () => {
    resetIconTheme();
    const calls: string[] = [];
    const api = fakeApi(
      { active: "material", themes: [{ id: "material", label: "Material" }] },
      manifest,
      calls,
    );
    await loadIconTheme("w1", api);
    await loadIconTheme("w1", api);
    expect(calls).toEqual(["catalog:w1", "manifest:w1"]);
    expect(iconThemeActive.value).toBe("material");
    expect(iconThemeThemes.value).toEqual([{ id: "material", label: "Material" }]);
    expect(iconFor("foo.d.ts")).toBe("/api/icon-theme/icons/file_type_dts.svg?workspace=w1");
    expect(iconFor("lib", { dir: true, expanded: true })).toBe(
      "/api/icon-theme/icons/folder-open.svg?workspace=w1",
    );
  });

  it("includes the workspace in the icon URL so the server can resolve the active theme", async () => {
    resetIconTheme();
    const calls: string[] = [];
    await loadIconTheme("ws-42", fakeApi({ active: "material", themes: [] }, manifest, calls));
    expect(iconFor("a.ts")).toBe("/api/icon-theme/icons/file_type_ts.svg?workspace=ws-42");
    // After a reset there is no workspace, so no URL is produced.
    resetIconTheme();
    expect(iconFor("a.ts")).toBeUndefined();
  });

  it("does not fetch the manifest when no theme is active", async () => {
    resetIconTheme();
    const calls: string[] = [];
    const api = fakeApi(
      { active: "none", themes: [{ id: "material", label: "Material" }] },
      manifest,
      calls,
    );
    await loadIconTheme("w1", api);
    expect(calls).toEqual(["catalog:w1"]);
    expect(iconThemeManifest.value).toBeUndefined();
    expect(iconFor("a.ts")).toBeUndefined();
  });

  it("treats a failing manifest as no theme without throwing", async () => {
    resetIconTheme();
    const api: IconThemeApi = {
      iconThemes: async () => ({ active: "material", themes: [] }),
      iconThemeManifest: async () => {
        throw new Error("HTTP 404");
      },
    };
    await loadIconTheme("w1", api);
    expect(iconThemeActive.value).toBe("none");
    expect(iconThemeManifest.value).toBeUndefined();
    expect(iconFor("a.ts")).toBeUndefined();
  });

  it("returns undefined from iconFor while no theme is active, even with a stale manifest", () => {
    resetIconTheme();
    iconThemeManifest.value = manifest;
    expect(iconFor("a.ts")).toBeUndefined();
  });

  it("reports a catalog failure through the error signal", async () => {
    resetIconTheme();
    const api: IconThemeApi = {
      iconThemes: async () => {
        throw new Error("boom");
      },
      iconThemeManifest: async () => manifest,
    };
    await loadIconTheme("w1", api);
    expect(iconThemeError.value).toBe("boom");
    expect(iconThemeActive.value).toBe("none");
  });
});
