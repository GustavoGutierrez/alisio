import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardWidget } from "@alisio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDashboard, type WidgetData } from "../packages/core/src/analysis/dashboard/index.ts";
import { ALISIO_RUNTIME_FILES } from "../packages/core/src/analysis/python/sources.ts";
import { pythonCommand } from "./data-helpers.ts";

/**
 * The TypeScript renderer and `alisio_runtime.charts` must emit the same DOM contract (spec 8.2):
 * the same fragment for the same chart, compared as a structure (attributes, spec JSON, table
 * cells), not as a string. The figcaption is the only intended difference: the TS card carries the
 * title in its `<h3>`.
 */
let dir: string;
beforeAll(() => {
  if (!pythonCommand) return;
  dir = mkdtempSync(join(tmpdir(), "alisio-render-parity-"));
  mkdirSync(join(dir, "alisio_runtime"));
  mkdirSync(join(dir, "out"));
  // The embedded copy (what python_run really gets), not the files in the repository.
  for (const [name, text] of Object.entries(ALISIO_RUNTIME_FILES))
    writeFileSync(join(dir, "alisio_runtime", name), text);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function pythonFragments(calls: Record<string, string>): Record<string, string> {
  const code = [
    "import json",
    "from alisio_runtime import charts",
    `out = {${Object.entries(calls)
      .map(([name, call]) => `${JSON.stringify(name)}: ${call}`)
      .join(", ")}}`,
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync(pythonCommand as string, ["-c", code], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: dir,
      ALISIO_OUTPUT_DIR: join(dir, "out"),
      PYTHONIOENCODING: "utf-8",
    },
  });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

interface Shape {
  figure: string;
  canvas: string;
  aria: string;
  canvasText: string;
  height: number;
  details: string;
  summary: string;
  headers: string[];
  rows: Array<Array<{ text: string; dv: string | null }>>;
  note: string | null;
  spec: unknown;
}

const attrs = (tag: string): string =>
  [...tag.matchAll(/\s([\w-]+)="([^"]*)"/g)]
    .map((m) => `${m[1]}=${m[2]}`)
    .sort()
    .join(" ");

/** Everything the boot script and the viewer can observe in one `<figure>`, minus the caption. */
function shapeOf(html: string): Shape {
  const figure = /<figure[^>]*>/.exec(html)?.[0] as string;
  const canvas = /<canvas([^>]*)>([\s\S]*?)<\/canvas>/.exec(html) as RegExpExecArray;
  const details = /<details[^>]*>/.exec(html)?.[0] as string;
  const table = /<table>([\s\S]*?)<\/table>/.exec(html)?.[1] as string;
  const spec = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] as string;
  return {
    figure: attrs(figure),
    canvas: attrs(`<canvas${canvas[1]}>`).replace(/aria-label=[^ ]*/, ""),
    aria: /aria-label="([^"]*)"/.exec(canvas[1] as string)?.[1] as string,
    canvasText: canvas[2] as string,
    height: Number(/--ac-h:(\d+)px/.exec(html)?.[1]),
    details: attrs(details),
    summary: /<summary>([\s\S]*?)<\/summary>/.exec(html)?.[1] as string,
    headers: [...table.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => m[1] as string),
    rows: [
      ...(/<tbody>([\s\S]*)<\/tbody>/.exec(table)?.[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g),
    ].map((row) =>
      [...(row[1] as string).matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((c) => ({
        text: c[2] as string,
        dv: /data-v="([^"]*)"/.exec(c[1] as string)?.[1] ?? null,
      })),
    ),
    note: /<p class="ac-note">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null,
    spec: JSON.parse(spec),
  };
}

function tsFragment(widget: DashboardWidget, data: WidgetData): string {
  const html = renderDashboard(
    {
      version: 1,
      title: "T",
      purpose: "analytical",
      layout: "analytical-grid",
      locale: "en",
      widgets: [widget],
    },
    [data],
  );
  return /<figure[\s\S]*<\/figure>/.exec(html)?.[0] as string;
}

const series = (type: "line" | "area" | "bar" | "hbar" | "pie" | "donut", title: string) =>
  ({
    id: "w",
    type,
    dimension: "d",
    metric: "m",
    aggregation: "sum",
    title,
  }) as DashboardWidget;

const pts = (labels: string[], values: number[]) =>
  labels.map((k, i) => ({ k, v: values[i] as number }));
const REGIONS = ["West", "East", "North"];
const SALES = [30, 20.5, 12];
const MONTHS = ["2024-01", "2024-02", "2024-03"];
const PY = (xs: unknown) => JSON.stringify(xs);

describe.skipIf(!pythonCommand)("TypeScript renderer and Python charts emit the same DOM", () => {
  const cases: Array<{ name: string; python: string; widget: DashboardWidget; data: WidgetData }> =
    [
      {
        name: "bar",
        python: `charts.bar(${PY(REGIONS)}, ${PY(SALES)}, title="Bars", locale="en", note="Top 3 of 9")`,
        widget: series("bar", "Bars"),
        data: { id: "w", type: "bar", points: pts(REGIONS, SALES), topOf: 9 },
      },
      {
        name: "hbar",
        python: `charts.hbar(${PY(REGIONS)}, ${PY(SALES)}, title="Ranking", locale="en")`,
        widget: series("hbar", "Ranking"),
        data: { id: "w", type: "hbar", points: pts(REGIONS, SALES) },
      },
      {
        name: "line",
        python: `charts.line(${PY(MONTHS)}, ${PY(SALES)}, title="Trend", locale="en")`,
        widget: series("line", "Trend"),
        data: { id: "w", type: "line", points: pts(MONTHS, SALES), bucket: "month" },
      },
      {
        name: "area",
        python: `charts.area(${PY(MONTHS)}, ${PY(SALES)}, title="Area", locale="en")`,
        widget: series("area", "Area"),
        data: { id: "w", type: "area", points: pts(MONTHS, SALES), bucket: "month" },
      },
      {
        name: "pie",
        python: `charts.pie(${PY(["Web", "Retail", "Partners"])}, ${PY([50, 30, 20])}, title="Share", locale="en")`,
        widget: series("pie", "Share"),
        data: { id: "w", type: "pie", points: pts(["Web", "Retail", "Partners"], [50, 30, 20]) },
      },
      {
        name: "pie with Other",
        python: `charts.pie(${PY("abcdefgh".split(""))}, ${PY([40, 30, 10, 8, 6, 3, 2, 1])}, title="Share", locale="en")`,
        widget: series("pie", "Share"),
        data: {
          id: "w",
          type: "pie",
          points: pts("abcde".split(""), [40, 30, 10, 8, 6]),
          other: 6,
        },
      },
      {
        name: "donut",
        python: `charts.donut(${PY(["Web", "Retail"])}, ${PY([81.7, 18.3])}, title="Ring", locale="en")`,
        widget: series("donut", "Ring"),
        data: { id: "w", type: "donut", points: pts(["Web", "Retail"], [81.7, 18.3]) },
      },
      {
        name: "scatter",
        python: `charts.scatter([1.5, 2.5, 3.5], [2, 5, 4], title="Corr", locale="en")`,
        widget: { id: "w", type: "scatter", x: "a", y: "b", title: "Corr" },
        data: {
          id: "w",
          type: "scatter",
          points: [
            [1.5, 2],
            [2.5, 5],
            [3.5, 4],
          ],
        },
      },
    ];

  const python = new Map<string, string>();
  beforeAll(() => {
    const out = pythonFragments(Object.fromEntries(cases.map((c) => [c.name, c.python])));
    for (const [name, html] of Object.entries(out)) python.set(name, html);
  });

  for (const c of cases)
    it(`${c.name}: same element structure, attributes, spec JSON and table`, () => {
      const py = shapeOf(python.get(c.name) as string);
      const ts = shapeOf(tsFragment(c.widget, c.data));
      expect(ts).toEqual(py);
    });

  it("both put the same classes on the figure the boot script waits for", () => {
    const py = shapeOf(python.get("bar") as string);
    expect(py.figure).toContain("class=ac-chart ac-pending");
    expect(py.figure).toContain("data-ac-chart=bar");
  });

  it("both pages carry the same assets (CSS, boot script, Chart.js) and inline the library once", () => {
    const [py] = Object.values(
      pythonFragments({
        page: `charts.page("T", charts.card("Bars", charts.bar(${PY(REGIONS)}, ${PY(SALES)})))`,
      }),
    );
    const ts = renderDashboard(
      {
        version: 1,
        title: "T",
        purpose: "analytical",
        layout: "analytical-grid",
        locale: "en",
        widgets: [series("bar", "Bars")],
      },
      [{ id: "w", type: "bar", points: pts(REGIONS, SALES) }],
    );
    const assets = (html: string) => ({
      css: ALISIO_RUNTIME_FILES["charts.css"] && html.includes(ALISIO_RUNTIME_FILES["charts.css"]),
      base:
        ALISIO_RUNTIME_FILES["html-base.css"] &&
        html.includes(ALISIO_RUNTIME_FILES["html-base.css"]),
      boot:
        ALISIO_RUNTIME_FILES["charts-boot.js"] &&
        html.includes(ALISIO_RUNTIME_FILES["charts-boot.js"]),
      lib: html.match(/Chart\.js v\d/g)?.length,
    });
    expect(assets(ts)).toEqual({ css: true, base: true, boot: true, lib: 1 });
    expect(assets(py as string)).toEqual(assets(ts));
  });
});
