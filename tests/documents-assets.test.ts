import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAssets, sniffImage } from "../packages/core/src/documents/assets.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let root: string;
let ws: string;
let bundle: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-doc-assets-"));
  ws = join(root, "ws");
  bundle = join(root, "bundle");
  await mkdir(join(ws, "img"), { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFile(join(ws, "img", "a.png"), PNG);
  await writeFile(join(root, "secret.png"), PNG);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const ctx = () => ({ workspaceRoot: ws, trusted: true });

describe("resolveAssets (DOC-AC-04, DOC-AC-05)", () => {
  it("copies a workspace image into the bundle", async () => {
    const out = await resolveAssets([{ id: "a", path: "img/a.png", alt: "x" }], bundle, ctx());
    expect(out.skipped).toEqual([]);
    expect(out.assets.get("a")).toMatchObject({ file: "assets/a.png", mime: "image/png" });
  });

  it("denies absolute paths, .. segments, symlink escapes and untrusted projects without echoing absolute paths", async () => {
    await symlink(join(root, "secret.png"), join(ws, "img", "link.png"));
    const cases: Array<[string, boolean]> = [
      [join(root, "secret.png"), true],
      ["../secret.png", true],
      ["img/../../secret.png", true],
      ["img/link.png", true],
    ];
    for (const [path] of cases) {
      const error = await resolveAssets([{ id: "a", path }], bundle, ctx()).catch(
        (e) => e as Error,
      );
      expect(error).toMatchObject({ code: "DOCUMENT_ASSET_DENIED" });
      expect((error as Error).message).not.toContain(root);
    }
    await expect(
      resolveAssets([{ id: "a", path: "img/a.png" }], bundle, {
        workspaceRoot: ws,
        trusted: false,
      }),
    ).rejects.toMatchObject({
      code: "DOCUMENT_ASSET_DENIED",
    });
  });

  it("skips missing, SVG, wrong-type and oversize images with a reason instead of failing", async () => {
    await writeFile(join(ws, "img", "fake.png"), "not an image at all");
    await writeFile(
      join(ws, "img", "logo.svg"),
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await writeFile(
      join(ws, "img", "big.png"),
      Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]),
    );
    const out = await resolveAssets(
      [
        { id: "ok", path: "img/a.png" },
        { id: "fake", path: "img/fake.png", alt: "Fake" },
        { id: "svg", path: "img/logo.svg", alt: "Logo" },
        { id: "big", path: "img/big.png" },
        { id: "gone", path: "img/missing.png", alt: "Gone" },
        { id: "art", artifactId: "nope" },
      ],
      bundle,
      ctx(),
    );
    expect([...out.assets.keys()]).toEqual(["ok"]);
    expect(out.skipped.map((k) => k.id)).toEqual(["fake", "svg", "big", "gone", "art"]);
    expect(out.skipped.find((k) => k.id === "svg")).toMatchObject({
      alt: "Logo",
      reason: expect.stringMatching(/SVG.*script/),
    });
    expect(out.skipped.find((k) => k.id === "gone")?.reason).toMatch(/not found/);
    for (const k of out.skipped) expect(k.reason).not.toContain(root);
  });

  it("sanitizes SVG assets into the bundle", async () => {
    await writeFile(
      join(ws, "img", "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="#336699"/></svg>',
    );
    const out = await resolveAssets(
      [{ id: "logo", path: "img/logo.svg", alt: "L" }],
      bundle,
      ctx(),
    );
    expect(out.skipped).toEqual([]);
    expect(out.assets.get("logo")).toMatchObject({
      file: "assets/logo.svg",
      mime: "image/svg+xml",
    });
    const written = await readFile(join(bundle, "assets", "logo.svg"), "utf8");
    expect(written).toContain('<rect width="4" height="4" fill="#336699"/>');
  });

  it("still fails the call when the total size of the images is too large", async () => {
    const mid = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
    const requests = [];
    for (let i = 0; i < 6; i++) {
      await writeFile(join(ws, "img", `m${i}.png`), mid);
      requests.push({ id: `m${i}`, path: `img/m${i}.png` });
    }
    await expect(resolveAssets(requests, bundle, ctx())).rejects.toMatchObject({
      code: "DOCUMENT_LIMIT_EXCEEDED",
    });
  });

  it("reads artifacts through the session reader and needs exactly one source", async () => {
    const out = await resolveAssets([{ id: "g", artifactId: "art_1" }], bundle, {
      ...ctx(),
      readArtifact: async (id) => (id === "art_1" ? new Uint8Array(PNG) : undefined),
    });
    expect(out.assets.has("g")).toBe(true);
    await expect(resolveAssets([{ id: "g" }], bundle, ctx())).rejects.toMatchObject({
      code: "DOCUMENT_ASSET_DENIED",
    });
  });

  it("recognizes PNG, JPEG, WebP and GIF only", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))?.mime).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a....."))?.mime).toBe("image/gif");
    expect(sniffImage(Buffer.from("<svg xmlns='x'></svg>"))).toBeUndefined();
  });
});
