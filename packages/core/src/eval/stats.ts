/** Pure statistics of the reliability lab (specs/010 D6, D17). No I/O, no dependencies. */

/** z of a two-sided 95 % interval. */
const Z95 = 1.96;

/**
 * Wilson score interval of a proportion (default 95 %). Unlike the normal approximation it stays
 * inside [0, 1] and is informative at 0/n and n/n. With no trials it carries no information.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z: number = Z95,
): { low: number; high: number } {
  if (!Number.isInteger(trials) || trials < 0)
    throw new RangeError(`trials must be a non-negative integer, got ${trials}.`);
  if (!Number.isInteger(successes) || successes < 0 || successes > trials)
    throw new RangeError(`successes must be an integer in [0, ${trials}], got ${successes}.`);
  if (trials === 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  // Floating point can leave 1e-17 residue at the extremes; the bounds there are exact.
  return {
    low: successes === 0 ? 0 : Math.max(0, centre - half),
    high: successes === trials ? 1 : Math.min(1, centre + half),
  };
}

/** Median; null for an empty set. Does not mutate the input. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Sample variance (n - 1), the same convention as `scripts/eval-baseline.ts`; null below two samples. */
export function sampleVariance(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
}

/** pass@k: at least one of the k repetitions succeeded. No repetitions is not a pass. */
export function passAtK(results: boolean[]): boolean {
  return results.some(Boolean);
}

/** pass^k: every one of the k repetitions succeeded (consistency). No repetitions is not a pass. */
export function passPowK(results: boolean[]): boolean {
  return results.length > 0 && results.every(Boolean);
}
