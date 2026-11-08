/**
 * Charts as SVG from data (spec 026 `chart` block). The model supplies numbers and labels, never
 * SVG: this file draws the markup, escapes every string and only uses classes (the theme's CSS
 * sets colors, strokes and the bundled font), so the result needs no inline style.
 */
import { DocumentError } from "./limits.ts";

export interface ChartInput {
  kind: "bar" | "line" | "pie";
  title?: string | undefined;
  labels: readonly string[];
  series: ReadonlyArray<{ name: string; values: readonly number[] }>;
  unit?: string | undefined;
  /** BCP 47 language for number formatting (default `en`). */
  lang?: string | undefined;
}

const W = 600;
const SERIES_CLASSES = 6;
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const r = (n: number) => Math.round(n * 10) / 10;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const invalid = (message: string) => new DocumentError("DOCUMENT_INPUT_INVALID", message);

/** An axis from `min` to `max` in readable steps; always includes zero. */
export function niceScale(lo: number, hi: number): { min: number; max: number; step: number } {
  const low = Math.min(0, lo);
  const high = Math.max(0, hi);
  if (high === low) return { min: 0, max: 1, step: 0.25 };
  const raw = (high - low) / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  return {
    min: Math.floor(low / step) * step,
    max: Math.ceil(high / step) * step,
    step,
  };
}

function formatter(lang: string | undefined) {
  let nf: Intl.NumberFormat;
  try {
    nf = new Intl.NumberFormat(lang ?? "en", { maximumFractionDigits: 2 });
  } catch {
    nf = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
  }
  const compact = new Intl.NumberFormat(nf.resolvedOptions().locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return (v: number, unit?: string) =>
    `${Math.abs(v) >= 100_000 ? compact.format(v) : nf.format(v)}${unit ? ` ${unit}` : ""}`;
}

function legend(names: readonly string[]): { svg: string; width: number } {
  let x = 0;
  const parts = names.map((name, i) => {
    const label = clip(name, 24);
    const part = `<rect class="legend-key s${i % SERIES_CLASSES}" x="${r(x)}" y="-9" width="10" height="10" rx="2"/><text class="legend" x="${r(x + 15)}" y="0">${esc(label)}</text>`;
    x += 15 + label.length * 6.2 + 18;
    return part;
  });
  return { svg: parts.join(""), width: x - 18 };
}

function validate(input: ChartInput) {
  const { labels, series } = input;
  if (labels.length === 0 || series.length === 0)
    throw invalid("A chart needs at least one label and one series.");
  for (const s of series) {
    if (s.values.length !== labels.length)
      throw invalid(
        `Series "${s.name}" has ${s.values.length} values for ${labels.length} labels.`,
      );
    if (s.values.some((v) => !Number.isFinite(v)))
      throw invalid(`Series "${s.name}" has values that are not finite numbers.`);
  }
}

export function chartSvg(input: ChartInput): string {
  validate(input);
  const fmt = formatter(input.lang);
  const label = input.title ?? "Chart";
  const head = (h: number, body: string) =>
    `<svg class="chart-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${body}</svg>`;
  if (input.kind === "pie") return pie(input, fmt, head);

  const { labels, series } = input;
  const n = labels.length;
  const all = series.flatMap((s) => [...s.values]);
  const scale = niceScale(Math.min(...all), Math.max(...all));
  const rotated = n > 6 || labels.some((l) => l.length > 12);
  const showLegend = series.length > 1;
  const H = 320;
  const left = 58;
  const top = showLegend ? 38 : 16;
  const bottom = rotated ? 74 : 40;
  const pw = W - left - 16;
  const ph = H - top - bottom;
  const y = (v: number) => top + ph - ((v - scale.min) / (scale.max - scale.min)) * ph;
  const parts: string[] = [];
  if (showLegend)
    parts.push(`<g transform="translate(${left} 18)">${legend(series.map((s) => s.name)).svg}</g>`);
  for (let v = scale.min; v <= scale.max + scale.step / 2; v += scale.step) {
    const yy = r(y(v));
    parts.push(
      `<line class="${v === 0 ? "axis" : "grid"}" x1="${left}" y1="${yy}" x2="${W - 16}" y2="${yy}"/><text class="tick" x="${left - 8}" y="${r(yy + 3.5)}" text-anchor="end">${esc(fmt(v))}</text>`,
    );
  }
  const group = pw / n;
  const center = (i: number) => left + group * (i + 0.5);
  labels.forEach((l, i) => {
    const x = r(center(i));
    const yy = H - bottom + 16;
    parts.push(
      rotated
        ? `<text class="xl" x="${x}" y="${yy}" text-anchor="end" transform="rotate(-35 ${x} ${yy})">${esc(clip(l, 18))}</text>`
        : `<text class="xl" x="${x}" y="${yy}" text-anchor="middle">${esc(clip(l, 14))}</text>`,
    );
  });
  const labelled = n * series.length <= 14;
  if (input.kind === "bar") {
    const inner = group * 0.72;
    const bw = inner / series.length;
    series.forEach((s, k) => {
      s.values.forEach((v, i) => {
        const x = center(i) - inner / 2 + bw * k;
        const y0 = y(0);
        const y1 = y(v);
        parts.push(
          `<rect class="bar s${k % SERIES_CLASSES}" x="${r(x + 0.5)}" y="${r(Math.min(y0, y1))}" width="${r(Math.max(1, bw - 1))}" height="${r(Math.max(0.5, Math.abs(y0 - y1)))}" rx="1.5"/>`,
        );
        if (labelled)
          parts.push(
            `<text class="val" x="${r(x + bw / 2)}" y="${r(v >= 0 ? y1 - 4 : y1 + 11)}" text-anchor="middle">${esc(fmt(v, input.unit))}</text>`,
          );
      });
    });
  } else {
    series.forEach((s, k) => {
      const pts = s.values.map((v, i) => `${r(center(i))},${r(y(v))}`).join(" ");
      parts.push(`<polyline class="line s${k % SERIES_CLASSES}" points="${pts}"/>`);
      s.values.forEach((v, i) => {
        parts.push(
          `<circle class="dot s${k % SERIES_CLASSES}" cx="${r(center(i))}" cy="${r(y(v))}" r="3"/>`,
        );
        if (labelled)
          parts.push(
            `<text class="val" x="${r(center(i))}" y="${r(y(v) - 8)}" text-anchor="middle">${esc(fmt(v, input.unit))}</text>`,
          );
      });
    });
  }
  return head(H, parts.join(""));
}

function pie(
  input: ChartInput,
  fmt: (v: number, unit?: string) => string,
  head: (h: number, body: string) => string,
): string {
  const values = (input.series[0] as { values: readonly number[] }).values;
  const total = values.reduce((a, b) => a + b, 0);
  if (values.some((v) => v < 0) || total <= 0)
    throw invalid("A pie chart needs non-negative values with a positive total.");
  const H = Math.max(260, 60 + input.labels.length * 22);
  const cx = 150;
  const cy = H / 2;
  const rad = Math.min(110, H / 2 - 14);
  const parts: string[] = [];
  let angle = -Math.PI / 2;
  const point = (a: number) => `${r(cx + rad * Math.cos(a))} ${r(cy + rad * Math.sin(a))}`;
  const nonZero = values.filter((v) => v > 0).length;
  values.forEach((v, i) => {
    if (v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const cls = `slice s${i % SERIES_CLASSES}`;
    if (nonZero === 1)
      parts.push(
        `<path class="${cls}" d="M ${point(angle)} A ${rad} ${rad} 0 1 1 ${point(angle + Math.PI)} A ${rad} ${rad} 0 1 1 ${point(angle)} Z"/>`,
      );
    else
      parts.push(
        `<path class="${cls}" d="M ${cx} ${cy} L ${point(angle)} A ${rad} ${rad} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(angle + sweep)} Z"/>`,
      );
    angle += sweep;
  });
  const pct = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
  input.labels.forEach((l, i) => {
    const v = values[i] as number;
    const yy = 40 + i * 22;
    parts.push(
      `<rect class="legend-key s${i % SERIES_CLASSES}" x="300" y="${yy - 10}" width="10" height="10" rx="2"/><text class="legend" x="318" y="${yy}">${esc(clip(l, 26))}</text><text class="val" x="${W - 16}" y="${yy}" text-anchor="end">${esc(fmt(v, input.unit))} (${pct.format((v / total) * 100)} %)</text>`,
    );
  });
  return head(H, parts.join(""));
}
