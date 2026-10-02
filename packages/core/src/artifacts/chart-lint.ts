/**
 * A cheap, deterministic quality gate for HTML dashboards: it spots the chart mistakes that models
 * make when they hand-write charts (SVG pie arcs, fixed-size SVGs, libraries loaded from a CDN that
 * the viewer blocks) and names the helper that avoids them. It only produces warnings for the
 * `python_run` / `artifact_create` result; it never rejects an artifact.
 */

const HELPERS = "alisio_runtime.charts (Chart.js, interactive) or alisio_runtime.svg (static)";

/** Strips scripts and styles so a bundled library never triggers the markup checks. */
function markupOf(html: string): string {
  return html
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1</script>")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "<style></style>");
}

/** `d` attributes that draw a wedge: a line to/from the centre, an arc command and a close. */
function wedgeCount(markup: string): number {
  let count = 0;
  for (const match of markup.matchAll(/<path\b[^>]*?\sd\s*=\s*["']([^"']*)["']/gi)) {
    const d = match[1] ?? "";
    if (
      /[Aa]\s*[\d.]+[\s,]+[\d.]+[\s,]+-?[\d.]+[\s,]+[01][\s,]*[01]/.test(d) &&
      /[Ll]/.test(d) &&
      /[Zz]/.test(d)
    )
      count++;
  }
  return count;
}

const numeric = (value: string | undefined): number | undefined => {
  const match = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/.exec(value ?? "");
  return match ? Number(match[1]) : undefined;
};

/** Fixed-size SVG charts: numeric width and height, no `viewBox` (they do not scale with the card). */
function fixedSvgCount(markup: string): number {
  let count = 0;
  for (const block of markup.split(/<svg\b/i).slice(1)) {
    const tagEnd = block.indexOf(">");
    if (tagEnd < 0) continue;
    const tag = block.slice(0, tagEnd);
    const body = block.slice(tagEnd, Math.max(tagEnd, block.search(/<\/svg\s*>/i)));
    const attr = (name: string) =>
      new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
    const width = numeric(attr("width"));
    const height = numeric(attr("height"));
    const drawn = (body.match(/<(?:rect|path|polyline|circle|line)\b/gi) ?? []).length;
    if (
      width !== undefined &&
      height !== undefined &&
      width >= 150 &&
      drawn >= 4 &&
      !/\sviewBox\s*=/i.test(tag)
    )
      count++;
  }
  return count;
}

/** `<script src>`, `<link href>` and `@import` that point at the network. */
function remoteHosts(markup: string, html: string): string[] {
  const hosts = new Set<string>();
  const sources = [
    ...markup.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi),
    ...markup.matchAll(/<link\b[^>]*\shref\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi),
    ...html.matchAll(/@import\s+(?:url\()?["']?((?:https?:)?\/\/[^"')\s]+)/gi),
  ];
  for (const match of sources) {
    try {
      hosts.add(new URL((match[1] as string).replace(/^\/\//, "https://")).host);
    } catch {
      // Not a URL: ignore it.
    }
  }
  return [...hosts];
}

/** Warnings (empty when the page looks fine) for one HTML document. */
export function chartWarnings(html: string): string[] {
  const markup = markupOf(html);
  const warnings: string[] = [];
  const hosts = remoteHosts(markup, html);
  if (hosts.length)
    warnings.push(
      `loads resources from the network (${hosts.slice(0, 3).join(", ")}); the viewer blocks the network, so they will not load. Charts: use ${HELPERS}, which inlines Chart.js`,
    );
  const wedges = wedgeCount(markup);
  if (wedges >= 2)
    warnings.push(
      `${wedges} hand-written SVG arc paths look like a pie or donut; hand-written arcs are often wrong (large-arc flag, 100% slice). Use charts.pie/donut or svg.pie/donut`,
    );
  const fixed = fixedSvgCount(markup);
  if (fixed)
    warnings.push(
      `${fixed} SVG chart${fixed === 1 ? "" : "s"} with a fixed width and height and no viewBox will not scale with its container (small text, empty space). Use ${HELPERS}, or give the SVG a viewBox and width:100%`,
    );
  return warnings;
}
