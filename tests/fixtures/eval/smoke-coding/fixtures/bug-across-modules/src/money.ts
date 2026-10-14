/** Converts a price in dollars to whole cents. */
export const toCents = (amount: number): number => Math.floor(amount * 100);
