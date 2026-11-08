/**
 * Two-pass table of contents page numbers on Chromium (spec 026 D-23). Pass 1 prints the contents
 * with fixed-width placeholders; the named destinations of its link annotations give each
 * heading's page; pass 2 prints the real numbers and the map is compared with the injected one
 * (three passes in total). If it never stabilizes the contents print as links only.
 */
export type TocMode =
  | { kind: "placeholder" }
  | { kind: "numbers"; pages: ReadonlyMap<string, number> }
  | { kind: "none" };

export interface TocLink {
  from: number;
  name?: string | undefined;
  page?: number | undefined;
}

export function pagesFromLinks(
  links: readonly TocLink[],
  headingIds: ReadonlySet<string>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of links)
    if (l.name && l.page && headingIds.has(l.name) && !map.has(l.name)) map.set(l.name, l.page);
  return map;
}

const same = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

export interface TocResult<T> {
  value: T;
  stable: boolean;
  passes: number;
  pages?: ReadonlyMap<string, number>;
}

export async function twoPassToc<T>(
  render: (mode: TocMode) => Promise<{ value: T; links: TocLink[] }>,
  headingIds: ReadonlySet<string>,
  maxNumbered = 2,
): Promise<TocResult<T>> {
  let passes = 1;
  const first = await render({ kind: "placeholder" });
  let map = pagesFromLinks(first.links, headingIds);
  while (map.size > 0 && passes <= maxNumbered) {
    passes++;
    const next = await render({ kind: "numbers", pages: map });
    const measured = pagesFromLinks(next.links, headingIds);
    if (same(map, measured)) return { value: next.value, stable: true, passes, pages: map };
    map = measured;
  }
  const plain = await render({ kind: "none" });
  return { value: plain.value, stable: false, passes: passes + 1 };
}
