import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { decideEffect } from "../packages/core/src/permissions/decide.ts";
import { registerDocumentTools } from "../packages/core/src/tools/documents.ts";
import { FakeEngine, makePdf } from "./documents-helpers.ts";

let root: string;
let ws: string;
let tmp: string;
let published: string[];
let htmlPublished: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-doc-tool-"));
  ws = join(root, "ws");
  tmp = join(root, "tmp");
  await mkdir(ws, { recursive: true });
  published = [];
  htmlPublished = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

function setup(
  engine: FakeEngine | null,
  settings: { engine?: "auto" | "chromium" | "weasyprint" } = {},
) {
  const registry = new ToolRegistry();
  registerDocumentTools(registry, {
    tmpRoot: tmp,
    engines: () => (engine ? [engine] : []),
    settings: () => ({ engine: settings.engine ?? "auto", defaultPageSize: "A4" }),
    trusted: () => true,
  });
  const artifact = (fileName: string) => ({
    artifact: {
      id: "art_1",
      sessionId: "s",
      title: fileName,
      fileName,
      kind: "document",
      mimeType: "application/pdf",
      bytes: 10,
      fileCount: 1,
      previewable: true,
      createdAt: 0,
      status: "ready",
    },
    path: "/x",
    warnings: [],
  });
  const context = (signal = new AbortController().signal): ToolContext =>
    ({
      signal,
      workspace: ws,
      emit: () => {},
      session: "s",
      artifacts: {
        publishDetailed: async (input: { source: string }) => {
          await copyFile(input.source, join(root, "out.pdf"));
          published.push(input.source);
          return artifact("report.pdf");
        },
        publishTextDetailed: async (input: { fileName: string; text: string }) => {
          htmlPublished.push(input.text);
          return artifact(input.fileName);
        },
      },
    }) as unknown as ToolContext;
  const call = (name: string, input: Record<string, unknown>, ctx = context()) => {
    const tool = registry.list().find((t) => t.name === name);
    if (!tool) throw new Error(`missing ${name}`);
    return tool.execute(input, ctx);
  };
  return { registry, call, context };
}
const text = (r: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>) =>
  (r.content[0] as { text: string }).text;

describe("document_create with a fake engine", () => {
  it("renders Markdown, publishes the PDF as an artifact and removes the render dir (DOC-AC-22)", async () => {
    const engine = new FakeEngine();
    const { call } = setup(engine);
    const r = await call("document_create", {
      markdown: "---\ntitle: Hola\nlang: es\n---\n# Uno\n\ntexto",
      theme: "data-report",
    });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(
      /PDF created: report\.pdf \(2 pages, theme data-report, chromium Fake\/1/,
    );
    expect(r.content.some((c) => c.type === "ui")).toBe(true);
    expect((await readFile(join(root, "out.pdf"))).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await readdir(tmp)).toEqual([]);
    expect(engine.jobs[0]).toMatchObject({
      page: { size: "A4", orientation: "portrait" },
      wantTagged: true,
      measure: true,
    });
  });

  it("rejects invalid input before any render with JSON pointers and enforces exactly one source (DOC-AC-01)", async () => {
    const engine = new FakeEngine();
    const { call } = setup(engine);
    const bad = await call("document_create", {
      spec: { version: 1, blocks: [{ type: "image", asset: "nope" }] },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^DOCUMENT_INPUT_INVALID/);
    expect(text(bad)).toContain("/blocks/0/asset");
    expect(text(await call("document_create", {}))).toMatch(/^DOCUMENT_INPUT_INVALID/);
    expect(text(await call("document_create", { markdown: "a", theme: "nope" }))).toMatch(
      /Unknown theme/,
    );
    expect(
      text(
        await call("document_create", {
          markdown: "a",
          theme: "executive-clean",
          page: { size: "A4" },
          spec: { version: 1, blocks: [] },
        }),
      ),
    ).toMatch(/exactly one/);
    expect(engine.jobs).toHaveLength(0);
  });

  it("denies assets outside the workspace without echoing absolute paths (DOC-AC-04)", async () => {
    const { call } = setup(new FakeEngine());
    const r = await call("document_create", { markdown: "![x](../secret.png)" });
    expect(text(r)).toMatch(/^DOCUMENT_ASSET_DENIED/);
    expect(text(r)).not.toContain(root);
  });

  it("reads markdownPath and resolves its relative images against the file (DOC-AC-07)", async () => {
    await mkdir(join(ws, "docs", "img"), { recursive: true });
    await writeFile(
      join(ws, "docs", "img", "a.png"),
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
    );
    await writeFile(
      join(ws, "docs", "r.md"),
      "# R\n\n![fig](img/a.png)\n\n![r](https://x.test/y.png)",
    );
    const engine = new FakeEngine();
    const { call } = setup(engine);
    const r = await call("document_create", { markdownPath: "docs/r.md" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("remote_image_skipped");
    expect(text(await call("document_create", { markdownPath: "../x.md" }))).toMatch(
      /^DOCUMENT_ASSET_DENIED/,
    );
  });

  it("repairs a wide table within two attempts and lists the repairs (DOC-AC-15)", async () => {
    const engine = new FakeEngine({
      measurements: [
        { overflow: [{ block: 0, tag: "div", overflowPx: 90 }], lowDpi: [] },
        { overflow: [{ block: 0, tag: "div", overflowPx: 30 }], lowDpi: [] },
        { overflow: [], lowDpi: [] },
      ],
    });
    const { call } = setup(engine);
    const spec = {
      version: 1,
      blocks: [{ type: "table", columns: [{ label: "a" }], rows: [["1"]] }],
    };
    const r = await call("document_create", { spec });
    expect(engine.jobs).toHaveLength(3);
    expect(engine.jobs[1]?.page.orientation).toBe("landscape");
    expect(text(r)).toContain("repaired (overflow): page switched to landscape");
    expect(text(r)).toContain("repaired (overflow): tables set to compact density");
    expect(text(r)).toContain("Checks: passed");
  });

  it("publishes with qa failed when an overflow cannot be repaired, and never repairs in fast mode (DOC-AC-16)", async () => {
    const stuck = { overflow: [{ block: 0, tag: "div", overflowPx: 90 }], lowDpi: [] };
    const spec = {
      version: 1,
      blocks: [{ type: "table", columns: [{ label: "a" }], rows: [["1"]] }],
    };
    const slow = new FakeEngine({ measurements: [stuck] });
    const r1 = await setup(slow).call("document_create", { spec, quality: "professional" });
    expect(slow.jobs).toHaveLength(3);
    expect(text(r1)).toContain("Checks: FAILED");
    const fast = new FakeEngine({ measurements: [stuck] });
    const r2 = await setup(fast).call("document_create", { spec, quality: "fast" });
    expect(fast.jobs).toHaveLength(1);
    expect(text(r2)).not.toContain("repaired");
  });

  it("answers DOCUMENT_ENGINE_UNAVAILABLE with reasons and fixes and publishes a printable HTML (DOC-AC-10)", async () => {
    const { call } = setup(new FakeEngine({ ready: false }));
    const r = await call("document_create", { markdown: "# Hola" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^DOCUMENT_ENGINE_UNAVAILABLE/);
    expect(text(r)).toContain("no browser");
    expect(text(r)).toContain("install one");
    expect(htmlPublished).toHaveLength(1);
    expect(htmlPublished[0]).toMatch(/<style>/);
    expect(htmlPublished[0]).not.toContain("document.invalid");
    expect(htmlPublished[0]).not.toContain("Content-Security-Policy");
  });

  it("with no engine registered also falls back to the HTML", async () => {
    const { call } = setup(null);
    expect(text(await call("document_create", { markdown: "# Hola" }))).toMatch(
      /^DOCUMENT_ENGINE_UNAVAILABLE/,
    );
    expect(htmlPublished).toHaveLength(1);
  });

  it("reports glyphs_missing, removes emoji and degrades the toc honestly", async () => {
    const { call } = setup(new FakeEngine());
    const r = await call("document_create", { markdown: "---\ntoc: true\n---\n# Hola 你好 😀" });
    expect(text(r)).toContain("glyphs_missing");
    expect(text(r)).toContain("emoji_removed");
    expect(text(r)).toContain("degraded toc_page_numbers");
    expect(text(r)).toContain("Checks: FAILED");
  });

  it("flags an embedded font that is not bundled (D10)", async () => {
    const engine = new FakeEngine({ pdf: () => makePdf({ fonts: ["AAAAAA+DejaVuSans"] }) });
    expect(text(await setup(engine).call("document_create", { markdown: "# a" }))).toContain(
      "font_not_bundled",
    );
  });

  it("answers DOCUMENT_RENDER_FAILED when the engine throws and cancels cleanly (DOC-AC-17)", async () => {
    const broken = new FakeEngine({ delayMs: 5000 });
    const controller = new AbortController();
    const { call, context } = setup(broken);
    const pending = call("document_create", { markdown: "# a" }, context(controller.signal));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("images, covers and brand colors in the tool", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  it("skips an unsafe SVG or a missing image with a warning, keeps a placeholder and still publishes", async () => {
    await writeFile(
      join(ws, "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await writeFile(join(ws, "ok.png"), PNG);
    const engine = new FakeEngine();
    const { call } = setup(engine);
    const r = await call("document_create", {
      markdown:
        "# Manual\n\n## Marca\n\n![Logo principal](logo.svg)\n\n![Fondo](gone.png)\n\n![Foto](ok.png)",
    });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("image_skipped");
    expect(text(r)).toMatch(/Logo principal.*SVG/);
    expect(text(r)).toMatch(/Fondo.*not found/);
    expect(text(r)).not.toContain("Foto");
    expect(text(r)).toContain("Checks: passed");
    expect(engine.jobs).toHaveLength(1);
  });

  it("keeps path escapes, absolute paths and untrusted projects as hard errors", async () => {
    const { call } = setup(new FakeEngine());
    for (const href of ["../x.png", "/etc/hostname"])
      expect(text(await call("document_create", { markdown: `![x](${href})` }))).toMatch(
        /^DOCUMENT_ASSET_DENIED/,
      );
  });

  it("accepts theme {id, accent, ink}, darkens a weak accent with a warning and rejects invalid colors", async () => {
    const { call } = setup(new FakeEngine());
    const ok = await call("document_create", {
      markdown: "# T\n\ntexto",
      theme: { id: "data-report", accent: "#c2410c" },
    });
    expect(text(ok)).toContain("theme data-report");
    expect(text(ok)).not.toContain("accent_adjusted");
    const weak = await call("document_create", { markdown: "# T", theme: { accent: "#ffd400" } });
    expect(text(weak)).toContain("accent_adjusted");
    const bad = await call("document_create", { markdown: "# T", theme: { accent: "orange" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^DOCUMENT_INPUT_INVALID.*hex/);
  });

  it("cover:false removes the cover for Markdown and for a spec", async () => {
    const engine = new FakeEngine();
    const { call } = setup(engine);
    await call("document_create", {
      markdown: "# Título\n\n**Versión:** 1\n\n## Uno",
      cover: false,
    });
    await call("document_create", {
      spec: {
        version: 1,
        blocks: [
          { type: "cover", title: "T" },
          { type: "paragraph", text: "x" },
        ],
      },
      cover: false,
    });
    expect(engine.jobs).toHaveLength(2);
  });
});

describe("document_themes and registration (DOC-AC-20)", () => {
  it("lists themes, blocks and the engine state within 4000 characters", async () => {
    const { call } = setup(new FakeEngine());
    const r = await call("document_themes", {});
    const t = text(r);
    expect(t.length).toBeLessThanOrEqual(4000);
    for (const id of ["executive-clean", "data-report", "technical-spec"]) expect(t).toContain(id);
    expect(t).toContain("stat_grid");
    expect(t).toContain("chromium ready");
  });

  it("declares honest effects that pass the single permission gate", () => {
    const { registry } = setup(new FakeEngine());
    const get = (n: string) => registry.list().find((t) => t.name === n);
    expect(get("document_create")?.effect).toBe("internal");
    expect(get("document_themes")?.effect).toBe("read");
    const policy = { write: false, process: false, external: false, analysis: false } as never;
    for (const n of ["document_create", "document_themes"])
      expect(decideEffect(policy, get(n) as never, { approvals: false } as never).kind).toBe(
        "allow",
      );
  });
});

describe("application wiring", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    vi.unstubAllEnvs();
  });
  async function app(documents?: { enabled: boolean }) {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify(documents ? { documents } : {}),
    );
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const created = await createApplication({
      cwd: ws,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: {
        id: "p",
        model: "m",
        async *stream() {
          yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
        },
      },
    });
    apps.push(created);
    return created;
  }

  it("registers the tools and the Documents rule by default, also without Forja", async () => {
    const a = await app();
    const names = a.registry.list().map((t) => t.name);
    expect(names).toContain("document_create");
    expect(names).toContain("document_themes");
    const session = a.store.create(ws, "p", "m").id;
    expect(await a.context.instructions(session)).toContain("# Documents");
  });

  it("documents.enabled=false removes the tools and the rule", async () => {
    const a = await app({ enabled: false });
    expect(a.registry.list().map((t) => t.name)).not.toContain("document_create");
    const session = a.store.create(ws, "p", "m").id;
    expect(await a.context.instructions(session)).not.toContain("# Documents");
  });

  it("--read-only offers no document tools", async () => {
    await mkdir(join(root, "config"), { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const a = await createApplication({
      cwd: ws,
      db: join(root, "state", "s.sqlite"),
      noHerdr: true,
      readOnly: true,
      provider: { id: "p", model: "m", async *stream() {} } as never,
    });
    apps.push(a);
    expect(a.registry.list().map((t) => t.name)).not.toContain("document_create");
  });
});
