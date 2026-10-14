import { formatCents } from "./format.ts";
import { toCents } from "./money.ts";

export function formatTotal(unitPrice: number, quantity: number): string {
  return formatCents(toCents(unitPrice) * quantity);
}
