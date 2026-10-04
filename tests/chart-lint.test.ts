import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALISIO_RUNTIME_FILES } from "../packages/core/src/analysis/python/sources.ts";
import { chartWarnings } from "../packages/core/src/artifacts/chart-lint.ts";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

/** What models hand-write: wedges with a wrong arc, a fixed-size SVG, a CDN script. */
const HAND_PIE = `<svg width="400" height="300">
  <path d="M200,150 L200,50 A100,100 0 0,1 296,176 Z" fill="#2f6fdb"/>
  <path d="M200,150 L296,176 A100,100 0 1,1 200,50 Z" fill="#e0692b"/>
  <rect x="1" y="1" width="5" height="5"/><circle cx="3" cy="3" r="2"/>
</svg>`;

describe("chart quality gate", () => {
  it("flags hand-written SVG pie arcs and fixed-size SVG charts, naming the helpers", () => {
    const warnings = chartWarnings(`<body>${HAND_PIE}</body>`);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(
      /2 hand-written SVG arc paths.*charts\.pie\/donut or svg\.pie\/donut/,
    );
    expect(warnings.join("\n")).toMatch(/1 SVG chart with a fixed width and height and no viewBox/);
    expect(warnings.join("\n")).toContain("alisio_runtime.charts");
  });

  it("flags libraries loaded from the network (the viewer blocks them)", () => {
    const [warning] = chartWarnings(
      '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><link rel="stylesheet" href="//fonts.googleapis.com/x.css">',
    );
    expect(warning).toContain("cdn.jsdelivr.net");
    expect(warning).toContain("fonts.googleapis.com");
    expect(warning).toContain("inlines Chart.js");
  });

  it("names dashboard_generate only when asked to (analysis.smartDashboard)", () => {
    const html = `<body>${HAND_PIE}<script src="https://cdn.example.com/c.js"></script></body>`;
    const off = chartWarnings(html);
    expect(off.join("\n")).not.toContain("dashboard_generate");
    expect(chartWarnings(html, { dashboard: false })).toEqual(off);
    const on = chartWarnings(html, { dashboard: true });
    expect(on).toHaveLength(off.length);
    expect(on.join("\n")).toContain("or dashboard_generate");
    expect(on.join("\n")).toContain("alisio_runtime.charts");
  });

  it("accepts responsive SVGs, relative scripts and a single arc (an icon)", () => {
    expect(
      chartWarnings(
        '<svg viewBox="0 0 400 300" style="width:100%"><rect/><rect/><rect/><rect/></svg><script src="assets/app.js"></script>' +
          '<svg width="24" height="24"><path d="M4,4 L8,4 A4,4 0 0,1 12,8 Z"/></svg>',
      ),
    ).toEqual([]);
  });

  it("does not scan inline scripts: a bundled library never triggers it", () => {
    const lib = ALISIO_RUNTIME_FILES["chart.umd.min.js"] as string;
    expect(chartWarnings(`<html><body><script>${lib}</script></body></html>`)).toEqual([]);
  });

  it("stays fast on a large page", () => {
    const big = `<svg viewBox="0 0 1 1">${"<path d='M0,0 L1,1'/>".repeat(20_000)}</svg>`;
    const started = Date.now();
    chartWarnings(big);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("publishing warns about broken charts without rejecting them", () => {
  let root: string;
  let db: SQLiteStore;
  afterEach(async () => {
    db?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("returns the warnings for a single HTML file and for a multi-file dashboard", async () => {
    root = await mkdtemp(join(tmpdir(), "alisio-lint-"));
    const staging = join(root, "job", "staging");
    await mkdir(join(staging, "board"), { recursive: true });
    db = new SQLiteStore(join(root, "state", "sessions.sqlite"));
    db.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
         VALUES('exec_1','s','r','/w','managed','completed','x','j',1)`,
      )
      .run();
    const store = new ArtifactStore({ root: join(root, "state"), db: db.db });
    await writeFile(join(staging, "single.html"), `<html><body>${HAND_PIE}</body></html>`);
    await writeFile(join(staging, "board", "index.html"), `<body>${HAND_PIE}</body>`);
    const published = await store.publishOutputs(staging, {
      sessionId: "s",
      rootSessionId: "r",
      workspace: "/w",
      executionId: "exec_1",
    });
    expect(published).toHaveLength(2);
    for (const item of published) {
      expect(item.artifact.kind).toBe("dashboard");
      expect(item.warnings.join("\n")).toMatch(/hand-written SVG arc paths/);
    }
  });

  it("names dashboard_generate in the published warnings only when the store is told to", async () => {
    root = await mkdtemp(join(tmpdir(), "alisio-lint-"));
    const staging = join(root, "job", "staging");
    await mkdir(join(staging, "board"), { recursive: true });
    db = new SQLiteStore(join(root, "state", "sessions.sqlite"));
    db.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
         VALUES('exec_1','s','r','/w','managed','completed','x','j',1)`,
      )
      .run();
    await writeFile(join(staging, "single.html"), `<html><body>${HAND_PIE}</body></html>`);
    await writeFile(join(staging, "board", "index.html"), `<body>${HAND_PIE}</body>`);
    const origin = { sessionId: "s", rootSessionId: "r", workspace: "/w", executionId: "exec_1" };
    const warningsOf = async (dashboard: boolean, n: number) => {
      const store = new ArtifactStore({ root: join(root, `state${n}`), db: db.db, dashboard });
      return (await store.publishOutputs(staging, origin)).flatMap((p) => p.warnings).join("\n");
    };
    expect(await warningsOf(true, 1)).toContain("or dashboard_generate");
    expect(await warningsOf(false, 2)).not.toContain("dashboard_generate");
  });
});
