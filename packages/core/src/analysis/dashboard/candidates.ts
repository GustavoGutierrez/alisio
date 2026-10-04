/**
 * Shortlists of columns for the dashboard (spec 6.1): measures ≤ 8, dimensions ≤ 8, time ≤ 4, each
 * ranked by a deterministic score, ties broken by ordinal. Pure.
 */
import { hintsOf } from "./hints.ts";
import type { ProfiledColumn } from "./profile.ts";

export interface Candidates {
  measures: ProfiledColumn[];
  dimensions: ProfiledColumn[];
  time: ProfiledColumn[];
  /** Shortlisted dimensions with 2 to 8 values, in dimension order: fit for a share-of-total chart. */
  compositionDims: ProfiledColumn[];
}

export const CANDIDATE_LIMITS = { measures: 8, dimensions: 8, time: 4 } as const;

const flag = (value: boolean): number => (value ? 1 : 0);

function measureScore(column: ProfiledColumn): number {
  const hints = hintsOf(column.name, column.label);
  return (
    1 -
    column.nullRatio +
    0.3 * flag(hints.magnitude) -
    0.5 * flag(hints.negative) +
    0.2 * flag(column.varies)
  );
}

function dimensionScore(column: ProfiledColumn): number {
  const hints = hintsOf(column.name, column.label);
  const d = column.distinct;
  return (
    1 -
    column.nullRatio +
    0.5 * flag(d >= 3 && d <= 12) +
    0.25 * flag(d >= 13 && d <= 30) +
    0.3 * flag(hints.dimension) -
    0.5 * flag(d > 100)
  );
}

function timeScore(column: ProfiledColumn): number {
  const hints = hintsOf(column.name, column.label);
  return (
    1 -
    column.nullRatio +
    0.3 * flag(hints.time) +
    0.1 * Math.min(1, (column.span?.days ?? 0) / 365)
  );
}

/** Highest score first; equal scores keep the dataset's own column order. */
function shortlist(
  columns: ProfiledColumn[],
  score: (column: ProfiledColumn) => number,
  limit: number,
): ProfiledColumn[] {
  return columns
    .map((column) => ({ column, score: score(column) }))
    .sort((a, b) => b.score - a.score || a.column.ordinal - b.column.ordinal)
    .slice(0, limit)
    .map((entry) => entry.column);
}

export function buildCandidates(columns: ProfiledColumn[]): Candidates {
  const byRole = (role: ProfiledColumn["role"]) => columns.filter((c) => c.role === role);
  const dimensions = shortlist(byRole("dimension"), dimensionScore, CANDIDATE_LIMITS.dimensions);
  return {
    measures: shortlist(byRole("measure"), measureScore, CANDIDATE_LIMITS.measures),
    dimensions,
    time: shortlist(byRole("time"), timeScore, CANDIDATE_LIMITS.time),
    compositionDims: dimensions.filter((c) => c.distinct >= 2 && c.distinct <= 8),
  };
}
