import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuiltinPlugin } from "@alisio/core";
import type { IconThemeProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "./server-helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/** A built-in plugin that registers the given icon-theme providers on setup. */
const iconThemeBuiltin = (themes: IconThemeProvider[]): BuiltinPlugin => ({
  id: "test-icon-theme",
  description: "Test icon themes",
  create: () => ({
    id: "test-icon-theme",
    version: "1.0.0",
    apiVersion: 1,
    setup(api) {
      for (const theme of themes) api.extensions.register("icon-theme", theme);
    },
  }),
});

/** A theme directory with two SVGs and a small VSCode-style manifest. */
async function themeOnDisk(root: string, id: string) {
  const iconsDir = join(root, `${id}-icons`);
  await mkdir(iconsDir, { recursive: true });
  await writeFile(join(iconsDir, `${id}.svg`), `<svg id="${id}"></svg>`);
  const manifestPath = join(root, `${id}.json`);
  await writeFile(
    manifestPath,
    JSON.stringify({
      iconDefinitions: { _file: { iconPath: `./${id}.svg` } },
      file: "_file",
    }),
  );
  return { id, label: `${id} theme`, iconsDir, manifestPath } satisfies IconThemeProvider;
}

async function fixture(): Promise<{
  t: TestServer;
  wid: string;
  material: IconThemeProvider;
  other: IconThemeProvider;
}> {
  const root = await mkdtemp(join(tmpdir(), "alisio-icon-theme-"));
  const material = await themeOnDisk(root, "material");
  const other = await themeOnDisk(root, "other");
  const t = await startTestServer({
    app: { trustProject: true, builtins: [iconThemeBuiltin([material, other])] },
  });
  const workspaces = (await t.api.get("/api/workspaces?archived=all")).json<
    Array<{ id: string; path: string }>
  >();
  const wid = workspaces.find((w) => w.path === t.workspace)?.id;
  if (!wid) throw new Error("test workspace not found");
  return { t, wid, material, other };
}

describe("icon theme routes", () => {
  it("lists the catalog with no active theme by default", async () => {
    const { t, wid } = await fixture();
    try {
      const res = await t.api.get(`/api/icon-themes?workspace=${wid}`);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        active: "none",
        themes: [
          { id: "material", label: "material theme" },
          { id: "other", label: "other theme" },
        ],
      });
    } finally {
      await t.close();
    }
  });

  it("answers 404 for the manifest and every icon while no theme is active", async () => {
    const { t, wid } = await fixture();
    try {
      expect((await t.api.get(`/api/icon-theme/manifest?workspace=${wid}`)).status).toBe(404);
      expect((await t.api.get(`/api/icon-theme/icons/material.svg?workspace=${wid}`)).status).toBe(
        404,
      );
    } finally {
      await t.close();
    }
  });

  it("serves the active manifest and its icons, and never an inactive provider's icon", async () => {
    const { t, wid } = await fixture();
    try {
      await t.api.patch("/api/settings", {
        workspace: wid,
        key: "web.iconTheme",
        value: "material",
      });
      expect(
        (await t.api.get(`/api/icon-themes?workspace=${wid}`)).json<{ active: string }>().active,
      ).toBe("material");

      const manifest = await t.api.get(`/api/icon-theme/manifest?workspace=${wid}`);
      expect(manifest.status).toBe(200);
      expect(manifest.json()).toEqual({
        iconDefinitions: { _file: { iconPath: "./material.svg" } },
        file: "_file",
      });

      const icon = await t.api.get(`/api/icon-theme/icons/material.svg?workspace=${wid}`);
      expect(icon.status).toBe(200);
      expect(icon.headers["content-type"]).toBe("image/svg+xml");
      expect(icon.text).toBe('<svg id="material"></svg>');
      // An inactive provider's icon is not reachable through the active provider's directory.
      expect((await t.api.get(`/api/icon-theme/icons/other.svg?workspace=${wid}`)).status).toBe(
        404,
      );
    } finally {
      await t.close();
    }
  });

  it("rejects traversal, absolute and non-SVG names", async () => {
    const { t, wid } = await fixture();
    try {
      await t.api.patch("/api/settings", {
        workspace: wid,
        key: "web.iconTheme",
        value: "material",
      });
      // `..` and absolute paths never reach the filesystem: the name pattern rejects them (400).
      expect(
        (await t.api.get(`/api/icon-theme/icons/..%2Fsecret.svg?workspace=${wid}`)).status,
      ).toBe(400);
      expect(
        (await t.api.get(`/api/icon-theme/icons/%2Fetc%2Fpasswd.svg?workspace=${wid}`)).status,
      ).toBe(400);
      expect((await t.api.get(`/api/icon-theme/icons/material.txt?workspace=${wid}`)).status).toBe(
        400,
      );
    } finally {
      await t.close();
    }
  });

  it("treats an unknown active id as no theme", async () => {
    const { t, wid } = await fixture();
    try {
      await t.api.patch("/api/settings", {
        workspace: wid,
        key: "web.iconTheme",
        value: "ghost",
      });
      expect(
        (await t.api.get(`/api/icon-themes?workspace=${wid}`)).json<{ active: string }>().active,
      ).toBe("none");
      expect((await t.api.get(`/api/icon-theme/manifest?workspace=${wid}`)).status).toBe(404);
      expect((await t.api.get(`/api/icon-theme/icons/material.svg?workspace=${wid}`)).status).toBe(
        404,
      );
    } finally {
      await t.close();
    }
  });

  it("sends a strong ETag with immutable caching and answers 304 on If-None-Match", async () => {
    const { t, wid } = await fixture();
    try {
      await t.api.patch("/api/settings", {
        workspace: wid,
        key: "web.iconTheme",
        value: "material",
      });
      const icon = await t.api.get(`/api/icon-theme/icons/material.svg?workspace=${wid}`);
      const etag = String(icon.headers.etag);
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      const cache = String(icon.headers["cache-control"]);
      expect(cache).toContain("max-age=31536000");
      expect(cache).toContain("immutable");

      const cached = await t.api.get(`/api/icon-theme/icons/material.svg?workspace=${wid}`, {
        "If-None-Match": etag,
      });
      expect(cached.status).toBe(304);
      expect(cached.text).toBe("");
      expect(String(cached.headers.etag)).toBe(etag);
    } finally {
      await t.close();
    }
  });
});
