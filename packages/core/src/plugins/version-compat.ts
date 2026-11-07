/**
 * Minimal semver helpers for the plugin catalog: compare versions and check an `@alisio/sdk`
 * range (`^`, `~`, comparators, `x` wildcards, `||`). No dependency: the catalog only needs to
 * decide "newer?" and "compatible?". A pre-release orders below its release, but counts as that
 * release when checked against a range.
 */
type Triple = [number, number, number];
interface Parsed {
  triple: Triple;
  pre: string[];
}

function parse(version: string): Parsed | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!match) return undefined;
  return {
    triple: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function compareTriples(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff) return diff;
  }
  return 0;
}

/** Negative, zero or positive like a comparator; `undefined` when either version is malformed. */
export function comparePluginVersions(a: string, b: string): number | undefined {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return undefined;
  const core = compareTriples(left.triple, right.triple);
  if (core) return core;
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** A partial version (`1`, `1.2`, `1.x`, `*`) as its numeric parts (`undefined` = wildcard). */
function partial(text: string): (number | undefined)[] | undefined {
  const parts = text.replace(/^v/, "").split(".");
  if (parts.length > 3 || parts[0] === "") return undefined;
  const out: (number | undefined)[] = [];
  for (const part of parts) {
    if (part === "x" || part === "X" || part === "*") out.push(undefined);
    else if (/^\d+$/.test(part)) out.push(Number(part));
    else return undefined;
  }
  while (out.length < 3) out.push(undefined);
  return out;
}

type Comparator = (v: Triple) => boolean;

function comparator(token: string): Comparator | undefined {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!match) return undefined;
  const op = match[1] ?? "";
  const nums = partial(match[2] as string);
  if (!nums) return undefined;
  const [maj, min, pat] = nums;
  const floor: Triple = [maj ?? 0, min ?? 0, pat ?? 0];
  const ge = (v: Triple) => compareTriples(v, floor) >= 0;
  if (maj === undefined) return () => true;
  switch (op) {
    case "^": {
      const upper: Triple =
        maj > 0
          ? [maj + 1, 0, 0]
          : min === undefined
            ? [1, 0, 0]
            : min > 0 || pat === undefined
              ? [0, min + 1, 0]
              : [0, 0, pat + 1];
      return (v) => ge(v) && compareTriples(v, upper) < 0;
    }
    case "~": {
      const upper: Triple = min === undefined ? [maj + 1, 0, 0] : [maj, min + 1, 0];
      return (v) => ge(v) && compareTriples(v, upper) < 0;
    }
    case ">=":
      return ge;
    case ">": {
      const next: Triple =
        pat !== undefined
          ? [maj, min ?? 0, pat]
          : min !== undefined
            ? [maj, min + 1, 0]
            : [maj + 1, 0, 0];
      return pat !== undefined
        ? (v) => compareTriples(v, next) > 0
        : (v) => compareTriples(v, next) >= 0;
    }
    case "<":
      return (v) => compareTriples(v, floor) < 0;
    case "<=": {
      const top: Triple =
        pat !== undefined
          ? [maj, min ?? 0, pat + 1]
          : min !== undefined
            ? [maj, min + 1, 0]
            : [maj + 1, 0, 0];
      return (v) => compareTriples(v, top) < 0;
    }
    default: {
      // Exact or wildcard (`1.2.x`, `1`).
      if (pat !== undefined) return (v) => compareTriples(v, floor) === 0;
      const upper: Triple = min === undefined ? [maj + 1, 0, 0] : [maj, min + 1, 0];
      return (v) => ge(v) && compareTriples(v, upper) < 0;
    }
  }
}

/** Whether `version` satisfies `range`. An unparseable range or version never satisfies. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  const alternatives = range.split("||").map((part) => part.trim());
  return alternatives.some((alt) => {
    const tokens = alt
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return false;
    const checks = tokens.map(comparator);
    return checks.every((check) => check?.(parsed.triple) === true);
  });
}

export interface CatalogPluginStateInput {
  catalogVersion: string;
  installedVersion?: string;
  /** The plugin's declared `@alisio/sdk` range. */
  sdkRange?: string;
  /** The installed `@alisio/sdk` version, when known. */
  sdkVersion?: string;
}

export interface CatalogPluginState {
  installedVersion?: string;
  /** False only when both the range and the SDK version are known and do not match. */
  compatible: boolean;
  updateAvailable: boolean;
}

/** Install state of one catalog entry against what is installed and the running SDK. */
export function catalogPluginState(input: CatalogPluginStateInput): CatalogPluginState {
  const compatible =
    !input.sdkRange || !input.sdkVersion ? true : satisfiesRange(input.sdkVersion, input.sdkRange);
  const updateAvailable =
    input.installedVersion !== undefined &&
    (comparePluginVersions(input.catalogVersion, input.installedVersion) ?? 0) > 0;
  return {
    compatible,
    updateAvailable,
    ...(input.installedVersion !== undefined ? { installedVersion: input.installedVersion } : {}),
  };
}
