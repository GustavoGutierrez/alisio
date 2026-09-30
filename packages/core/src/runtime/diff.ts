/**
 * Unified line diffs for the `diff` UiBlock that `write_file`/`edit_file` attach for rich
 * clients (spec §8.6, RF-13). Myers O((N+M)·D) on lines after trimming the common prefix and
 * suffix; when the edit distance exceeds `maxD` the middle becomes a full replacement. Pure and
 * portable (no dependency). The web UI ships its own copy of the algorithm for third-party blocks
 * that only carry `before`/`after` (packages cannot share code with the browser bundle).
 */

type Op = 0 | 1 | 2; // equal, delete, insert

function myers(a: string[], b: string[], maxD: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((): Op => 2);
  if (!m) return a.map((): Op => 1);
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const snap = trace[d] as Int32Array;
    const at = (k: number) => snap[k + d + 1] as number;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(0);
      x--;
      y--;
    }
    ops.push(x === prevX ? 2 : 1);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push(0);
    x--;
    y--;
  }
  return ops.reverse();
}

/** Line edit script (0 equal, 1 delete, 2 insert). */
export function lineEdits(a: string[], b: string[], maxD = 2000): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB, maxD) ?? [...midA.map((): Op => 1), ...midB.map((): Op => 2)];
  return [...new Array<Op>(start).fill(0), ...middle, ...new Array<Op>(a.length - endA).fill(0)];
}

const NO_EOL = "\u0000no-eol";
/** Lines of a text; a last line without `\n` carries a marker so a newline change is a change. */
function linesOf(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else lines[lines.length - 1] = `${lines.at(-1)}${NO_EOL}`;
  return lines;
}

type Row = { op: Op; text: string; old: number; new: number };

/**
 * A unified patch (`--- a/path`, `+++ b/path`, hunks with `context` lines) from `before` to
 * `after`; `undefined` means the file did not exist. Identical texts give `""`.
 */
export function unifiedPatch(
  path: string,
  before: string | undefined,
  after: string | undefined,
  options: { context?: number } = {},
): string {
  const context = options.context ?? 3;
  const a = linesOf(before);
  const b = linesOf(after);
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  for (const op of lineEdits(a, b)) {
    if (op === 0) rows.push({ op, text: a[i] as string, old: i++, new: j++ });
    else if (op === 1) rows.push({ op, text: a[i] as string, old: i++, new: j });
    else rows.push({ op, text: b[j] as string, old: i, new: j++ });
  }
  const hunks: Array<[number, number]> = [];
  for (let k = 0; k < rows.length; k++) {
    if ((rows[k] as Row).op === 0) continue;
    const from = Math.max(0, k - context);
    const last = hunks.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.min(rows.length - 1, k + context);
    else hunks.push([from, Math.min(rows.length - 1, k + context)]);
  }
  if (!hunks.length) return "";
  const out = [
    `--- ${before === undefined ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`,
  ];
  const range = (start: number, count: number) =>
    count === 1 ? `${start + 1}` : `${count === 0 ? start : start + 1},${count}`;
  for (const [from, to] of hunks) {
    const slice = rows.slice(from, to + 1);
    const first = slice[0] as Row;
    const oldCount = slice.filter((r) => r.op !== 2).length;
    const newCount = slice.filter((r) => r.op !== 1).length;
    out.push(`@@ -${range(first.old, oldCount)} +${range(first.new, newCount)} @@`);
    for (const row of slice) {
      const noEol = row.text.endsWith(NO_EOL);
      const text = noEol ? row.text.slice(0, -NO_EOL.length) : row.text;
      out.push(`${row.op === 0 ? " " : row.op === 1 ? "-" : "+"}${text}`);
      if (noEol) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n");
}

/** Cuts `text` at a line boundary so it fits in `maxBytes` (UTF-8). */
export function clipLines(text: string, maxBytes: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, clipped: false };
  let cut = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
  // A split multi-byte character decodes to U+FFFD; drop the partial last line either way.
  const newline = cut.lastIndexOf("\n");
  cut = newline > 0 ? cut.slice(0, newline) : cut.replace(/�$/, "");
  return { text: cut, clipped: true };
}
