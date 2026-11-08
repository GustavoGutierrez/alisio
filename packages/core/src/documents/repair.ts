/**
 * Bounded deterministic repair (spec 026 D18, §5.8): finding codes map to presentation hints, at
 * most two attempts, content never changes except removing trailing page breaks.
 */
import type { PageSetup } from "./ports.ts";
import type { Finding } from "./qa.ts";
import type { RenderHints } from "./render-html.ts";
import type { DocumentSpec } from "./spec.ts";

export const MAX_REPAIRS = 2;

export interface RepairState {
  spec: DocumentSpec;
  hints: RenderHints;
  page: PageSetup;
  /** The call named an orientation: it is never changed. */
  orientationLocked: boolean;
}

export interface RepairStep {
  code: string;
  action: string;
  state: RepairState;
}

/** The next repair for these findings, or undefined when none applies. */
export function nextRepair(
  findings: readonly Finding[],
  state: RepairState,
): RepairStep | undefined {
  const blocks = state.spec.blocks;
  const overflowing = findings.filter((f) => f.code === "overflow");
  if (overflowing.length) {
    const tableOverflow = overflowing.some((f) => blocks[f.blockIndex ?? -1]?.type === "table");
    if (tableOverflow && !state.orientationLocked && state.page.orientation === "portrait")
      return {
        code: "overflow",
        action: "page switched to landscape",
        state: { ...state, page: { ...state.page, orientation: "landscape" } },
      };
    if (tableOverflow && state.hints.density !== "compact")
      return {
        code: "overflow",
        action: "tables set to compact density",
        state: { ...state, hints: { ...state.hints, density: "compact" } },
      };
    const imageOverflow = overflowing.some((f) => blocks[f.blockIndex ?? -1]?.type === "image");
    if (imageOverflow && !state.hints.mediumImages)
      return {
        code: "overflow",
        action: "images set to medium size",
        state: { ...state, hints: { ...state.hints, mediumImages: true } },
      };
  }
  if (findings.some((f) => f.code === "blank_trailing_page")) {
    const trimmed = [...blocks];
    while (trimmed.at(-1)?.type === "page_break") trimmed.pop();
    if (trimmed.length !== blocks.length)
      return {
        code: "blank_trailing_page",
        action: "trailing page break removed",
        state: { ...state, spec: { ...state.spec, blocks: trimmed } },
      };
  }
  return undefined;
}
