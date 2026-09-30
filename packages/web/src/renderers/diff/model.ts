/**
 * Diff model for the `diff` renderer (spec §10.4): a small unified-patch parser plus a Myers
 * line diff for blocks that only carry `before`/`after`. Pure and DOM-free (tested in Node).
 * No dependency: the core already emits unified patches for its own tools, so the parser is the
 * common path and the line diff only serves third-party blocks.
 */
import type { UiBlock } from "@alisio/sdk";

export type DiffLine =
  | { type: "ctx"; text: string; oldNo: number; newNo: number }
  | { type: "del"; text: string; oldNo: number; newNo?: undefined }
  | { type: "add"; text: string; newNo: number; oldNo?: undefined }
  /** `\ No newline at end of file` and similar markers. */
  | { type: "note"; text: string; oldNo?: undefined; newNo?: undefined };

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  hunks: DiffHunk[];
  added: number;
  removed: number;
  binary?: boolean;
}

type DiffBlock = Extract<UiBlock, { kind: "diff" }>;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const stripPrefix = (path: string) => path.replace(/^[ab]\//, "").replace(/\t.*$/, "");

/**
 * Parses a (possibly multi-file) unified patch. Hunk bodies are read by their header counts, so
 * a removed line that starts with `--` is never taken for a file header. Text without hunks
 * yields no hunks.
 */
export function parsePatch(patch: string, fallbackPath = ""): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let oldPath: string | undefined;
  const start = (): DiffFile => {
    const next: DiffFile = {
      path: fallbackPath,
      status: "modified",
      hunks: [],
      added: 0,
      removed: 0,
    };
    files.push(next);
    hunk = undefined;
    return next;
  };
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      const mark = line[0];
      const text = line.slice(1);
      if (mark === "+") {
        hunk.lines.push({ type: "add", text, newNo: newNo++ });
        file.added++;
        newLeft--;
        continue;
      }
      if (mark === "-") {
        hunk.lines.push({ type: "del", text, oldNo: oldNo++ });
        file.removed++;
        oldLeft--;
        continue;
      }
      if (mark === " " || line === "") {
        hunk.lines.push({ type: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (mark === "\\") {
        hunk.lines.push({ type: "note", text: line.slice(2) });
        continue;
      }
      oldLeft = newLeft = 0; // malformed body: fall through to header parsing
    }
    if (hunk && line.startsWith("\\")) {
      hunk.lines.push({ type: "note", text: line.slice(2) });
      continue;
    }
    if (line.startsWith("diff --git ")) {
      file = start();
      const match = / b\/(.+)$/.exec(line);
      if (match?.[1]) file.path = match[1];
      oldPath = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!file || file.hunks.length) file = start();
      oldPath = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("+++ ") && file && oldPath !== undefined) {
      const newPath = line.slice(4).trim();
      if (oldPath === "/dev/null") file.status = "added";
      if (newPath === "/dev/null") {
        file.status = "deleted";
        file.path = stripPrefix(oldPath);
      } else {
        file.path = stripPrefix(newPath);
        if (oldPath !== "/dev/null" && stripPrefix(oldPath) !== file.path) file.status = "renamed";
      }
      oldPath = undefined;
      continue;
    }
    const head = HUNK.exec(line);
    if (head) {
      file ??= start();
      oldNo = Number(head[1]);
      oldLeft = head[2] === undefined ? 1 : Number(head[2]);
      newNo = Number(head[3]);
      newLeft = head[4] === undefined ? 1 : Number(head[4]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    hunk = undefined;
    if (file && /^(new|deleted) file mode/.test(line))
      file.status = line.startsWith("new") ? "added" : "deleted";
    else if (file && /^Binary files .* differ$/.test(line)) file.binary = true;
  }
  return files;
}

type Op = 0 | 1 | 2; // equal, delete, insert

/** Myers O((N+M)·D) edit script, or undefined when D exceeds `maxD`. */
function myers(a: string[], b: string[], maxD: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map(() => 2);
  if (!m) return a.map(() => 1);
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

/** Line edit script with the common prefix/suffix trimmed first (the usual edit is small). */
function editScript(a: string[], b: string[], maxD = 2000): Op[] {
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

const splitText = (text: string): string[] => {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Hunks (with `context` lines around each change) between two texts. */
export function diffLines(before: string, after: string, context = 3): DiffHunk[] {
  const a = splitText(before);
  const b = splitText(after);
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const op of editScript(a, b)) {
    if (op === 0) all.push({ type: "ctx", text: a[i] as string, oldNo: ++i, newNo: ++j });
    else if (op === 1) all.push({ type: "del", text: a[i] as string, oldNo: ++i });
    else all.push({ type: "add", text: b[j] as string, newNo: ++j });
  }
  const hunks: DiffHunk[] = [];
  let current: DiffLine[] | undefined;
  let lastChange = -Infinity;
  for (let index = 0; index < all.length; index++) {
    const line = all[index] as DiffLine;
    if (line.type === "ctx") continue;
    if (!current || index - lastChange > 2 * context) {
      if (current) current.push(...all.slice(lastChange + 1, lastChange + 1 + context));
      current = all.slice(Math.max(0, index - context), index);
      hunks.push({ header: "", lines: current });
    } else current.push(...all.slice(lastChange + 1, index));
    current.push(line);
    lastChange = index;
  }
  if (current) current.push(...all.slice(lastChange + 1, lastChange + 1 + context));
  for (const hunk of hunks) hunk.header = hunkHeader(hunk.lines);
  return hunks;
}

function hunkHeader(lines: DiffLine[]): string {
  const olds = lines.filter((l) => l.oldNo !== undefined);
  const news = lines.filter((l) => l.newNo !== undefined);
  const range = (items: DiffLine[], key: "oldNo" | "newNo") =>
    items.length ? `${items[0]?.[key]},${items.length}` : "0,0";
  return `@@ -${range(olds, "oldNo")} +${range(news, "newNo")} @@`;
}

/** The files a diff block shows: its patch, or a line diff of before/after. */
export function filesOf(block: DiffBlock): DiffFile[] {
  const path = block.path ?? "";
  if (block.patch !== undefined) {
    const parsed = parsePatch(block.patch, path);
    return parsed.length ? parsed : [{ path, status: "modified", hunks: [], added: 0, removed: 0 }];
  }
  const hunks = diffLines(block.before ?? "", block.after ?? "");
  const count = (type: DiffLine["type"]) =>
    hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === type).length, 0);
  return [
    {
      path,
      status:
        block.before === undefined ? "added" : block.after === undefined ? "deleted" : "modified",
      hunks,
      added: count("add"),
      removed: count("del"),
    },
  ];
}

/** Side-by-side rows: context on both sides, runs of deletions paired with additions. */
export function splitRows(hunk: DiffHunk): Array<{ left?: DiffLine; right?: DiffLine }> {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = dels[k];
      const right = adds[k];
      rows.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.type === "del") {
      if (adds.length) flush();
      dels.push(line);
    } else if (line.type === "add") adds.push(line);
    else {
      flush();
      if (line.type === "ctx") rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}
