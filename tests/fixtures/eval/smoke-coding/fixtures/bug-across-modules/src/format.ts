/** Formats whole cents as a dollar string. */
export const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
