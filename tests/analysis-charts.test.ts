import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALISIO_RUNTIME_FILES } from "../packages/core/src/analysis/python/sources.ts";

const python = ["python3", "python"].find((cmd) => {
  const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 10))"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "True";
});

// The three datasets of the reported bug (pie of order status, pie of channel share, 4 sellers).
const STATUS = { labels: ["Delivered", "In transit", "Cancelled"], values: [81.7, 14.8, 3.4] };
const CHANNEL = { labels: ["Online", "Retail", "Partners"], values: [34.8, 33.7, 31.5] };
const SELLERS = {
  labels: ["Ana", "Luis", "Marta", "Pedro"],
  series: {
    Sales: [120000, 95000, 87000, 40000],
    Profit: [30000, 21000, 25000, 8000],
  },
};

let dir: string;
let out: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "alisio-charts-"));
  out = join(dir, "out");
  mkdirSync(join(dir, "alisio_runtime"));
  mkdirSync(out);
  // The embedded copy (what python_run really gets), not the files in the repository.
  for (const [name, text] of Object.entries(ALISIO_RUNTIME_FILES))
    writeFileSync(join(dir, "alisio_runtime", name), text);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a Python snippet against the embedded runtime and parses its JSON stdout. */
function run<T = unknown>(code: string): { value: T; stderr: string } {
  const r = spawnSync(python as string, ["-c", code], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, ALISIO_OUTPUT_DIR: out, PYTHONIOENCODING: "utf-8" },
  });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return { value: JSON.parse(r.stdout) as T, stderr: r.stderr };
}

interface Slice {
  index: number;
  value: number;
  percent: number;
  start: number;
  end: number;
  sweep: number;
  large_arc: number;
  full: boolean;
}
const slices = (values: unknown[], start?: number) =>
  run<Slice[]>(
    `import json; from alisio_runtime import svg; print(json.dumps(svg.pie_slices(${JSON.stringify(values).replace(/null/g, "None")}${start === undefined ? "" : `, ${start}`})))`,
  ).value;

describe.skipIf(!python)("svg pie geometry (pure function)", () => {
  it("splits the reported status data into three clockwise slices that close the circle", () => {
    const got = slices(STATUS.values);
    expect(got.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(got[0]?.start).toBeCloseTo(-90, 6);
    // Each slice starts where the previous one ended; the last one ends at start + 360 exactly.
    for (let i = 1; i < got.length; i++)
      expect(got[i]?.start).toBeCloseTo(got[i - 1]?.end as number, 9);
    expect(got[2]?.end).toBe(270);
    expect(got.reduce((sum, s) => sum + s.sweep, 0)).toBeCloseTo(360, 9);
    expect(got.map((s) => Number(s.percent.toFixed(1)))).toEqual([81.8, 14.8, 3.4]);
  });

  it("sets large-arc only on a slice wider than 180 degrees (the 81.7% one)", () => {
    expect(slices(STATUS.values).map((s) => s.large_arc)).toEqual([1, 0, 0]);
    expect(slices(CHANNEL.values).map((s) => s.large_arc)).toEqual([0, 0, 0]);
    // Exactly 180 degrees is not "large".
    expect(slices([1, 1]).map((s) => s.large_arc)).toEqual([0, 0]);
  });

  it("gives the three nearly equal channel shares ~120 degrees each", () => {
    const got = slices(CHANNEL.values);
    expect(got.map((s) => Math.round(s.sweep))).toEqual([125, 121, 113]);
  });

  it("treats a single (100%) slice as a full circle", () => {
    const [only] = slices([0, 5, 0]);
    expect(only).toMatchObject({ index: 1, full: true, large_arc: 1 });
    expect(only?.sweep).toBeCloseTo(360, 9);
  });

  it("keeps a tiny slice and skips zero, negative, NaN and text values", () => {
    const got = slices([1000, 0.0001, -5, null, "x", "12", 0]);
    expect(got.map((s) => s.index)).toEqual([0, 1, 5]);
    expect(got[1]?.sweep).toBeGreaterThan(0);
    expect(got[2]?.value).toBe(12);
    expect(got.at(-1)?.end).toBe(270);
  });

  it("returns nothing for a zero or empty total", () => {
    expect(slices([])).toEqual([]);
    expect(slices([0, 0])).toEqual([]);
    expect(slices([-1, null])).toEqual([]);
  });

  it("does not accumulate rounding error over many slices", () => {
    const got = slices(Array.from({ length: 200 }, () => 0.1));
    expect(got).toHaveLength(200);
    expect(got.at(-1)?.end).toBe(270);
    expect(Math.max(...got.map((s) => Math.abs(s.sweep - 1.8)))).toBeLessThan(1e-9);
  });

  it("honours another start angle", () => {
    expect(slices([1, 1], 0).map((s) => [s.start, s.end])).toEqual([
      [0, 180],
      [180, 360],
    ]);
  });
});

describe.skipIf(!python)("svg charts", () => {
  const svgOf = (call: string) =>
    run<string>(`import json; from alisio_runtime import svg; print(json.dumps(${call}))`).value;

  it("draws the 81.7% slice with large-arc 1 and every other slice with 0", () => {
    const svg = svgOf(
      `svg.pie(${JSON.stringify(STATUS.labels)}, ${JSON.stringify(STATUS.values)})`,
    );
    const arcs = [...svg.matchAll(/A([\d.]+),([\d.]+) 0 ([01]) 1 /g)].map((m) => m[3]);
    expect(arcs).toEqual(["1", "0", "0"]);
    // Legend with the real shares, and a title/desc for screen readers.
    expect(svg).toContain("81.8%");
    expect(svg).toContain("14.8%");
    expect(svg).toContain("<title>Pie chart.");
    expect(svg).toContain("<desc>");
  });

  it("draws a one-category pie as a disc (two half arcs), not an empty path", () => {
    const svg = svgOf(`svg.pie(["Only"], [10])`);
    expect(svg).toMatch(/d="M[\d.]+,[\d.]+A[\d.]+,[\d.]+ 0 1 1 [^"]+A[\d.]+,[\d.]+ 0 1 1 [^"]+Z"/);
  });

  it("scales with its container: a viewBox and no fixed pixel size on the root", () => {
    for (const call of [
      `svg.pie(${JSON.stringify(CHANNEL.labels)}, ${JSON.stringify(CHANNEL.values)})`,
      `svg.donut(["a","b"], [1,2])`,
      `svg.bar(${JSON.stringify(SELLERS.labels)}, ${JSON.stringify(SELLERS.series)})`,
      `svg.hbar(["a","b"], [1,2])`,
      `svg.line([1,2,3], {"s":[1,2,3]})`,
      `svg.area([1,2,3], [1,2,3])`,
      `svg.scatter([1,2,3], [3,2,1])`,
      `svg.bar([], [])`,
    ]) {
      const root = /<svg\b[^>]*>/.exec(svgOf(call))?.[0] ?? "";
      expect(root, call).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);
      expect(root, call).not.toMatch(/\swidth="\d/);
      expect(root, call).not.toMatch(/\sheight="\d/);
      expect(root, call).toContain("width:100%");
    }
  });

  it("groups the four-seller bars by series with a legend and value labels", () => {
    const svg = svgOf(
      `svg.bar(${JSON.stringify(SELLERS.labels)}, ${JSON.stringify(SELLERS.series)})`,
    );
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(8 + 2);
    expect(svg).toContain("Sales");
    expect(svg).toContain("Profit");
    expect(svg).toContain("120k");
  });

  it("folds extra pie categories into Other", () => {
    const grouped = run<[string[], number[]]>(
      `import json; from alisio_runtime import svg; print(json.dumps(svg.group_small(list("abcdefgh"), [50,20,10,8,5,4,2,1], max_slices=4)))`,
    ).value;
    expect(grouped[0]).toEqual(["a", "b", "c", "Other"]);
    expect(grouped[1]).toEqual([50, 20, 10, 20]);
  });

  it("rejects more series than the palette can tell apart", () => {
    const r = spawnSync(
      python as string,
      ["-c", `from alisio_runtime import svg; svg.bar(["a"], {str(i): [1] for i in range(9)})`],
      { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONPATH: dir } },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("9 series: at most 8");
  });

  it("escapes labels and survives empty or invalid data", () => {
    const svg = svgOf(`svg.bar(['<img onerror=x>'], [float('nan')])`);
    expect(svg).not.toContain("<img");
    expect(svgOf(`svg.pie([], [])`)).toContain("No data");
    expect(svgOf(`svg.line(['a'], [None])`)).toContain("No data");
  });
});

interface Spec {
  v: number;
  kind: string;
  labels: string[];
  series: Array<{ name: string; data: unknown[] }>;
  percents?: number[];
  stacked?: boolean;
  otherLast?: boolean;
  fmt: { locale?: string; unit?: string; options: Record<string, unknown> };
}
const specOf = (fragment: string): Spec => {
  const match = /<script type="application\/json">(.*?)<\/script>/s.exec(fragment);
  return JSON.parse(match?.[1] ?? "null") as Spec;
};
const fragmentOf = (call: string) =>
  run<string>(`import json; from alisio_runtime import charts; print(json.dumps(${call}))`);

describe.skipIf(!python)("charts (Chart.js helpers)", () => {
  it("builds the reported status pie with the right values and shares", () => {
    const { value } = fragmentOf(
      `charts.pie(${JSON.stringify(STATUS.labels)}, ${JSON.stringify(STATUS.values)}, title="Order status")`,
    );
    const spec = specOf(value);
    expect(spec).toMatchObject({ v: 1, kind: "pie", labels: STATUS.labels, otherLast: false });
    expect(spec.series).toEqual([{ name: "", data: STATUS.values }]);
    expect(spec.percents?.map((p) => Math.round(p * 10) / 10)).toEqual([81.8, 14.8, 3.4]);
    expect((spec.percents ?? []).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1);
    // Responsive container with a defined height, an accessible label and a data table.
    expect(value).toMatch(
      /<div class="ac-box" style="--ac-h:\d+px"><canvas role="img" aria-label="[^"]*Delivered/,
    );
    expect(value).not.toMatch(/<canvas[^>]*\s(width|height)=/);
    expect(value).toContain('<details class="ac-data" open>');
    expect(value).toContain("<td>Delivered</td>");
  });

  it("builds the reported channel pie (three near-equal shares)", () => {
    const spec = specOf(
      fragmentOf(`charts.pie(${JSON.stringify(CHANNEL.labels)}, ${JSON.stringify(CHANNEL.values)})`)
        .value,
    );
    expect(spec.series[0]?.data).toEqual(CHANNEL.values);
    expect(spec.percents).toEqual([34.8, 33.7, 31.5]);
  });

  it("builds the four-seller grouped bar chart", () => {
    const { value } = fragmentOf(
      `charts.bar(${JSON.stringify(SELLERS.labels)}, ${JSON.stringify(SELLERS.series)}, fmt="currency:USD", locale="en-US", title="Sellers")`,
    );
    const spec = specOf(value);
    expect(spec.kind).toBe("bar");
    expect(spec.stacked).toBe(false);
    expect(spec.labels).toEqual(SELLERS.labels);
    expect(spec.series).toEqual([
      { name: "Sales", data: SELLERS.series.Sales },
      { name: "Profit", data: SELLERS.series.Profit },
    ]);
    expect(spec.fmt).toEqual({
      locale: "en-US",
      options: { style: "currency", currency: "USD", maximumFractionDigits: 0 },
    });
    expect(value).toMatch(/--ac-h:\d+px/);
  });

  it("folds many pie categories into Other and flags it", () => {
    const labels = "abcdefghij".split("");
    const spec = specOf(
      fragmentOf(`charts.pie(${JSON.stringify(labels)}, [30,20,15,10,8,6,5,3,2,1])`).value,
    );
    expect(spec.labels.at(-1)).toBe("Other");
    expect(spec.labels.length).toBeLessThanOrEqual(6);
    expect(spec.otherLast).toBe(true);
    expect((spec.series[0]?.data as number[]).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });

  it("warns on stderr about dropped values and still renders", () => {
    const { value, stderr } = fragmentOf(`charts.pie(["a","b","c"], [5, 0, None])`);
    expect(specOf(value).labels).toEqual(["a"]);
    expect(stderr).toContain("left out of the pie");
  });

  it("returns a plain message (not a chart) for empty data", () => {
    const { value, stderr } = fragmentOf(`charts.hbar([], [])`);
    expect(value).toContain("ac-empty");
    expect(value).not.toContain("<canvas");
    expect(stderr).toContain("No data");
  });

  it("validates fmt and the number of series", () => {
    const r = spawnSync(
      python as string,
      ["-c", `from alisio_runtime import charts; charts.bar(["a"], [1], fmt="bogus")`],
      { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONPATH: dir } },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("fmt must be");
  });

  it("keeps the data safe inside the inline script (no </script>, no raw markup)", () => {
    const { value } = fragmentOf(`charts.bar(["</script><b>x"], [1])`);
    expect(value.match(/<\/script>/g)).toHaveLength(1);
    expect(value).not.toContain("<b>x");
    expect(specOf(value).labels).toEqual(["</script><b>x"]);
  });

  it("writes one self-contained page with Chart.js inlined once, whatever the number of charts", () => {
    const { value } = run<{ html: string; path: string }>(
      [
        "import json",
        "from alisio_runtime import charts",
        `body = charts.grid(charts.card('A', charts.pie(${JSON.stringify(STATUS.labels)}, ${JSON.stringify(STATUS.values)})),`,
        `  charts.card('B', charts.pie(${JSON.stringify(CHANNEL.labels)}, ${JSON.stringify(CHANNEL.values)})),`,
        `  charts.card('C', charts.bar(${JSON.stringify(SELLERS.labels)}, ${JSON.stringify(SELLERS.series)})))`,
        "path = charts.write('dash.html', 'Sales', charts.kpis(('Orders', '1')) + body)",
        "print(json.dumps({'html': path.read_text(encoding='utf-8'), 'path': str(path)}))",
      ].join("\n"),
    );
    const html = value.html;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect((html.match(/Chart\.js v\d/g) ?? []).length).toBe(1);
    expect((html.match(/data-ac-chart=/g) ?? []).length).toBe(3);
    expect(html).toContain('name="viewport"');
    // No network: no external script, stylesheet or import.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/@import/);
    // Dark mode follows the page scheme.
    expect(html).toContain("prefers-color-scheme:dark");
  });

  it("bundles a Chart.js build that needs no eval (the viewer CSP forbids it)", () => {
    const lib = ALISIO_RUNTIME_FILES["chart.umd.min.js"] as string;
    expect(lib).toContain("Chart.js v4");
    expect(lib).not.toMatch(/\beval\s*\(/);
    expect(lib).not.toMatch(/new\s+Function\s*\(/);
    expect(ALISIO_RUNTIME_FILES["chart.LICENSE.txt"]).toContain("MIT License");
  });
});
