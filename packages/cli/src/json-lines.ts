import { redactDeep } from "@alisio/core";

/**
 * One line of `alisio run --json`: the value as JSON with every string redacted (known token
 * values and JWTs, specs/025 D26a). Redaction walks the values, not the serialized text, so it
 * can never cut through the JSON syntax.
 */
export function jsonLine(value: unknown): string {
  return `${JSON.stringify(redactDeep(value))}\n`;
}
