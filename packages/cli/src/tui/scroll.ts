/** Pure scrolling helper shared by the panels that show long text in the picker slot. */

/** The visible slice of `lines` for `scroll` (clamped) and whether more lines exist. */
export function scrollWindow(
  lines: string[],
  scroll: number,
  height: number,
): { lines: string[]; scroll: number; above: boolean; below: boolean } {
  const max = Math.max(0, lines.length - height);
  const start = Math.min(Math.max(0, scroll), max);
  return {
    lines: lines.slice(start, start + height),
    scroll: start,
    above: start > 0,
    below: start + height < lines.length,
  };
}
