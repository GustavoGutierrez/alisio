/** Smallest whole number that is at least a / b, for a >= 0 and b > 0. */
export function ceilDiv(a: number, b: number): number {
  return Math.floor(a / b) + 1;
}
