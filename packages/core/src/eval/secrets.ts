/**
 * Secret scan applied to everything a cassette stores and every diff excerpt it prints (specs/010
 * 5.3, 10). It looks for well-known credential shapes plus the exact values of the credentials the
 * run could hold. A hit on write REFUSES the cassette (nothing is stripped: a stripped cassette
 * would silently stop matching what the model saw); diagnostics are redacted instead.
 *
 * Findings carry the rule name, never the matched text.
 */

const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: "Anthropic API key (sk-ant-...)", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: "API key (sk-...)", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token (ghp_/gho_)", pattern: /\bgh[po]_[A-Za-z0-9]{20,}/ },
  { name: "GitHub fine-grained token (github_pat_)", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "AWS access key id (AKIA...)", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token (xoxb-/xoxp-)", pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}/ },
  { name: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { name: "PEM private key header", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "*_API_KEY assignment",
    pattern: /\b[A-Z][A-Z0-9_]*_API_KEY\s*=\s*['"]?[^\s'"]{4,}/,
  },
];

/** Exact credential values shorter than this are ignored: they would match ordinary text. */
const MIN_EXACT_LENGTH = 8;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names of the rules `text` matches (each once). `exact` are credential values to look for verbatim. */
export function findSecrets(text: string, exact: readonly string[] = []): string[] {
  const hits: string[] = [];
  for (const rule of RULES) if (rule.pattern.test(text)) hits.push(rule.name);
  if (exact.some((value) => value.length >= MIN_EXACT_LENGTH && text.includes(value)))
    hits.push("a credential of the provider profile or environment");
  return hits;
}

/** `text` with every match replaced by `[redacted]`. */
export function redactSecrets(text: string, exact: readonly string[] = []): string {
  let out = text;
  for (const rule of RULES) out = out.replace(new RegExp(rule.pattern, "g"), "[redacted]");
  for (const value of exact)
    if (value.length >= MIN_EXACT_LENGTH)
      out = out.replace(new RegExp(escape(value), "g"), "[redacted]");
  return out;
}
