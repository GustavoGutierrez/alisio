/**
 * Finds the tables a plugin creates through `api.storage.sqlite(...).exec("CREATE TABLE ...")`:
 * the SQL text is scanned in the plugin sources (best-effort, for the schema view only; it never
 * runs the SQL and never decides anything about safety).
 */
import type { PluginCreatorSchema } from "@alisio/sdk";

type Table = PluginCreatorSchema["tables"][number];
type Column = Table["columns"][number];

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)`;
const CREATE = new RegExp(
  String.raw`CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s*\.\s*)?(${IDENT})\s*\(`,
  "gi",
);
const MAX_TABLES = 100;
const MAX_COLUMNS = 200;

const unquote = (name: string): string => name.trim().replace(/^["`[]|["`\]]$/g, "");

/** The body between the `(` at `start` and its matching `)`, or undefined. */
function body(text: string, start: number): string | undefined {
  let depth = 0;
  for (let i = start; i < text.length && i < start + 50_000; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return undefined;
}

/** Splits on commas that are not inside parentheses. */
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const names = (list: string) => list.split(",").map(unquote).filter(Boolean);
const REFERENCES = new RegExp(String.raw`REFERENCES\s+(${IDENT})\s*(?:\(([^)]*)\))?`, "i");

function parseTable(name: string, definition: string): Table {
  const columns: Column[] = [];
  const constraints: string[] = [];
  for (const part of topLevel(definition)) {
    if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(part)) {
      constraints.push(part);
      continue;
    }
    const match = new RegExp(String.raw`^(${IDENT})\s*(.*)$`).exec(part);
    if (!match || columns.length >= MAX_COLUMNS) continue;
    const rest = match[2] ?? "";
    const type =
      /^([A-Za-z][A-Za-z0-9_ ]*?(?:\([^)]*\))?)(?=\s+(?:PRIMARY|NOT|NULL|DEFAULT|REFERENCES|UNIQUE|CHECK|COLLATE|GENERATED|AS|CONSTRAINT)\b|$)/i.exec(
        rest,
      );
    const references = REFERENCES.exec(rest);
    columns.push({
      name: unquote(match[1] ?? ""),
      type: (type?.[1] ?? "").trim().toUpperCase(),
      pk: /\bPRIMARY\s+KEY\b/i.test(rest),
      notNull: /\bNOT\s+NULL\b/i.test(rest),
      ...(references
        ? {
            fk: {
              table: unquote(references[1] ?? ""),
              ...(references[2] ? { column: names(references[2])[0] } : {}),
            },
          }
        : {}),
    });
  }
  for (const constraint of constraints) {
    const pk = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(constraint);
    if (pk)
      for (const key of names(pk[1] ?? "")) {
        const column = columns.find((c) => c.name === key);
        if (column) column.pk = true;
      }
    const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(constraint);
    const ref = REFERENCES.exec(constraint);
    if (fk && ref) {
      const targets = ref[2] ? names(ref[2]) : [];
      names(fk[1] ?? "").forEach((key, index) => {
        const column = columns.find((c) => c.name === key);
        if (column && !column.fk)
          column.fk = {
            table: unquote(ref[1] ?? ""),
            ...(targets[index] ? { column: targets[index] } : {}),
          };
      });
    }
  }
  return { name, columns };
}

/** Tables of every `CREATE TABLE` in `sources` (first definition of a name wins). */
export function detectSchema(sources: string[]): PluginCreatorSchema {
  const tables: Table[] = [];
  for (const text of sources) {
    CREATE.lastIndex = 0;
    for (let match = CREATE.exec(text); match; match = CREATE.exec(text)) {
      if (tables.length >= MAX_TABLES) break;
      const name = unquote(match[1] ?? "");
      const definition = body(text, match.index + match[0].length - 1);
      if (!definition || tables.some((t) => t.name === name)) continue;
      tables.push(parseTable(name, definition));
    }
  }
  return { tables };
}
