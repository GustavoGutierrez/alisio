/**
 * Lexical guard of `data_query` (spec §17.3). `node:sqlite` has no authorizer or progress
 * handler and `DatabaseSync.prepare()` silently ignores text after the first statement, so the
 * guard checks the SQL itself: exactly one statement, starting with SELECT or WITH, without
 * write, schema, transaction or extension keywords outside literals and comments. The read-only
 * connection (`readOnly`, `query_only`, extensions off) is the second line of defence.
 */

const FORBIDDEN = new Set([
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "CREATE",
  "DROP",
  "ALTER",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "LOAD_EXTENSION",
]);

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

interface Token {
  /** `word` is an unquoted identifier or keyword; `punct` any other significant character. */
  type: "word" | "punct";
  text: string;
}

const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

/**
 * Splits SQL into significant tokens, skipping whitespace, comments and the contents of string
 * literals and quoted identifiers. Returns an error text for an unterminated literal or comment.
 */
function tokenize(sql: string): { tokens: Token[] } | { error: string } {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i] as string;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= n) return { error: `Unterminated ${c === "'" ? "string" : "identifier"}` };
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      // A quoted identifier or string is a value, not a keyword; it still counts as a token so
      // that "SELECT" 1 is not mistaken for an empty statement.
      tokens.push({ type: "punct", text: c });
      i = j + 1;
    } else if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      if (end < 0) return { error: "Unterminated identifier" };
      tokens.push({ type: "punct", text: "[" });
      i = end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? n : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return { error: "Unterminated comment" };
      i = end + 2;
    } else if (/\s/.test(c)) {
      i++;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j] as string)) j++;
      tokens.push({ type: "word", text: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ type: "punct", text: c });
      i++;
    }
  }
  return { tokens };
}

/**
 * Validates a model-written query. Accepts one `SELECT`/`WITH` statement (a single trailing `;`
 * is allowed and removed). Keywords inside literals, comments and quoted identifiers are fine;
 * `replace(…)` as a function is fine (REPLACE INTO is not).
 */
export function guardSql(sql: string): GuardResult {
  const scanned = tokenize(sql);
  if ("error" in scanned) return { ok: false, reason: scanned.error };
  const { tokens } = scanned;
  // Drop one trailing semicolon; any other one separates statements.
  if (tokens.at(-1)?.text === ";") tokens.pop();
  if (!tokens.length) return { ok: false, reason: "The query is empty" };
  if (tokens.some((t) => t.type === "punct" && t.text === ";"))
    return { ok: false, reason: "Only one statement is allowed (no `;` between statements)" };
  const first = tokens[0] as Token;
  if (first.type !== "word" || !["SELECT", "WITH"].includes(first.text.toUpperCase()))
    return { ok: false, reason: "Only SELECT and WITH queries are allowed" };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (token.type !== "word") continue;
    const word = token.text.toUpperCase();
    if (!FORBIDDEN.has(word)) continue;
    if (word === "REPLACE" && tokens[i + 1]?.text === "(") continue;
    return {
      ok: false,
      reason: `\`${token.text}\` is not allowed in a read-only query (quote column names that look like keywords, e.g. "${token.text}")`,
    };
  }
  return { ok: true, sql };
}
