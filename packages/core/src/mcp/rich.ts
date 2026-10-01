/**
 * MCP → Alisio result mapping ("Nivel 0" rich tool results).
 *
 * MCP protocol types never leak into the SDK: this adapter is the single place that folds an
 * MCP `CallToolResult` / `ReadResourceResult` into the Alisio-owned `ToolResult` content union
 * (text, image, ui blocks). Mapping is heuristic and conservative:
 *
 * - `text` parts stay text parts; an image part becomes `{type:"image"}` (base64 data + mime).
 * - `structuredContent` (or a JSON-parseable text part) is folded into a `ui` block when it
 *   matches a verified shape — `{columns,rows}` / `{headers,rows}` tables, all-scalar
 *   key-value objects, or `{nodes:[{label,children,meta}]}` trees. Anything else stays text
 *   (the previous flattening).
 * - A canonical text projection of every ui block / image is ALWAYS appended as a text part so
 *   providers, compaction and headless output only see text.
 * - Unknown call results (no contents, nothing recognized) keep the previous
 *   `JSON.stringify(result)` behavior verbatim.
 */
import { type ToolResult, type TreeNode, textResult, type UiBlock } from "@alisio/sdk";
import { stripAnsi } from "../startup/text.ts";

const scalar = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || value === null
      ? String(value)
      : undefined;

/** Cell rendering: scalars verbatim, nested values compact-JSON'd (never raw bytes). */
const cellText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

function tableShape(value: unknown): UiBlock | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const columnsRaw = Array.isArray(record.columns)
    ? record.columns
    : Array.isArray(record.headers)
      ? record.headers
      : undefined;
  const rowsRaw = Array.isArray(record.rows) ? record.rows : undefined;
  if (!columnsRaw || !rowsRaw) return undefined;
  const columns: string[] = [];
  for (const column of columnsRaw) {
    const text = scalar(column);
    if (text === undefined) return undefined;
    columns.push(text);
  }
  const rows: Array<Array<string>> = [];
  for (const row of rowsRaw) {
    if (!row || typeof row !== "object") return undefined;
    if (Array.isArray(row)) {
      rows.push(row.map(cellText));
      continue;
    }
    // Object rows are keyed by the declared columns (`{columns, rows:[{a:1,b:2}]}`).
    const named = row as Record<string, unknown>;
    rows.push(columns.map((column) => cellText(named[column])));
  }
  if (!columns.length || !rows.length) return undefined;
  return { kind: "table", columns, rows };
}

function treeNode(value: unknown): TreeNode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const label = scalar(record.label) ?? scalar(record.name);
  if (label === undefined) return undefined;
  const meta = scalar(record.meta) ?? scalar(record.value) ?? scalar(record.detail);
  const node: TreeNode = { label };
  if (meta !== undefined && meta !== label) node.meta = meta;
  const children = Array.isArray(record.children) ? record.children : undefined;
  if (children) {
    const mapped: TreeNode[] = [];
    for (const child of children) {
      const next = treeNode(child);
      if (!next) return undefined;
      mapped.push(next);
    }
    node.children = mapped;
  }
  return node;
}

function treeShape(value: unknown): UiBlock | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes
    : record.tree !== undefined && typeof record.tree === "object" && !Array.isArray(record.tree)
      ? [record.tree]
      : undefined;
  if (!nodes) return undefined;
  const mapped: TreeNode[] = [];
  for (const node of nodes) {
    const next = treeNode(node);
    if (!next) return undefined;
    mapped.push(next);
  }
  return mapped.length ? { kind: "tree", nodes: mapped } : undefined;
}

function keyValueShape(value: unknown): UiBlock | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (!entries.length || entries.some(([, v]) => typeof v === "object" && v !== null))
    return undefined;
  return { kind: "key-value", entries: entries.map(([key, v]) => [key, String(v)]) };
}

/**
 * Folds a candidate value into a UiBlock when it matches one of the verified shapes:
 * `{columns,rows}` / `{headers,rows}` tables, `{nodes:[...]}` trees, or flat scalar objects.
 */
export function blockFromUnknown(value: unknown): UiBlock | undefined {
  return tableShape(value) ?? treeShape(value) ?? keyValueShape(value);
}

/** Tries a JSON-parseable text part: recognized shapes become ui blocks, everything else stays text. */
export function blockFromJsonText(text: string): UiBlock | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return blockFromUnknown(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/** Compact plain-text rendering of a ui block, used as the canonical model-visible projection. */
export function renderUiBlockText(block: UiBlock): string {
  switch (block.kind) {
    case "table": {
      const head = `| ${block.columns.join(" | ")} |`;
      const sep = `| ${block.columns.map(() => "---").join(" | ")} |`;
      const rows = block.rows.map((row) => `| ${row.join(" | ")} |`);
      return [block.caption ? `[table: ${block.caption}]` : "", head, sep, ...rows]
        .filter((line) => line !== "")
        .join("\n");
    }
    case "key-value":
      return [
        block.caption ? `[key-value: ${block.caption}]` : "",
        ...block.entries.map(([key, value]) => `${key}: ${value}`),
      ]
        .filter((line) => line !== "")
        .join("\n");
    case "tree": {
      const lines: string[] = [];
      const walk = (nodes: TreeNode[], prefix: string) => {
        nodes.forEach((node, index) => {
          const last = index === nodes.length - 1;
          lines.push(
            `${prefix}${last ? "└─ " : "├─ "}${node.label}${node.meta ? ` (${node.meta})` : ""}`,
          );
          if (node.children?.length) walk(node.children, `${prefix}${last ? "   " : "│  "}`);
        });
      };
      walk(block.nodes, "");
      return lines.join("\n");
    }
    case "code": {
      const fence = "```";
      const lang = block.lang ? `${block.lang}\n` : "\n";
      const body = block.code.endsWith("\n") ? block.code : `${block.code}\n`;
      return [block.caption ? `[code: ${block.caption}]` : "", `${fence}${lang}${body}${fence}`]
        .filter((line) => line !== "")
        .join("\n");
    }
    case "markdown":
      return block.text;
    case "diff": {
      const label = [block.caption, block.path].filter(Boolean).join(" · ");
      const head = label ? `[diff: ${label}]` : "[diff]";
      if (block.patch !== undefined) return `${head}\n${fenced(block.patch, "diff")}`;
      return [
        head,
        `before:\n${fenced(block.before ?? "", block.lang)}`,
        `after:\n${fenced(block.after ?? "", block.lang)}`,
      ].join("\n");
    }
    case "terminal": {
      const status = [
        block.exitCode !== undefined ? `exit ${block.exitCode}` : "",
        block.durationMs !== undefined ? `${block.durationMs}ms` : "",
        block.truncated ? "output truncated" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        block.command ? `$ ${block.command}` : "[terminal]",
        fenced(stripAnsi(block.output)),
        status,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    case "mermaid":
      return [block.title ? `[mermaid: ${block.title}]` : "", fenced(block.source, "mermaid")]
        .filter((line) => line !== "")
        .join("\n");
    case "math":
      return block.display ? `$$\n${block.latex}\n$$` : `$${block.latex}$`;
    case "json":
      return [
        block.caption ? `[json: ${block.caption}]` : "",
        fenced(jsonText(block.value), "json"),
      ]
        .filter((line) => line !== "")
        .join("\n");
    case "test-results": {
      const cases = block.suites.flatMap((suite) =>
        suite.cases.map(
          (c) =>
            `${c.status.toUpperCase()} ${suite.name} › ${c.name}${c.error ? `: ${c.error}` : ""}`,
        ),
      );
      return [`[test-results${block.framework ? `: ${block.framework}` : ""}]`, ...cases].join(
        "\n",
      );
    }
    case "progress":
      return [
        block.title ? `[progress: ${block.title}]` : "[progress]",
        ...block.steps.map(
          (step) => `- [${step.status}] ${step.label}${step.detail ? ` (${step.detail})` : ""}`,
        ),
      ].join("\n");
    case "artifact": {
      const a = block.artifact;
      return `[artifact: ${a.fileName} · ${a.kind} · ${a.bytes} bytes · ${a.id}${a.partial ? " · partial" : ""}${a.status !== "ready" ? ` · ${a.status}` : ""}]`;
    }
    default: {
      // A kind this build does not know (e.g. persisted by a newer Alisio): keep it readable.
      const kind = String((block as { kind?: unknown }).kind ?? "unknown");
      return `[ui block: ${kind}]\n${fenced(jsonText(block), "json")}`;
    }
  }
}

function fenced(text: string, lang?: string): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `\`\`\`${lang ?? ""}\n${body}\`\`\``;
}

/** `JSON.stringify` that never throws and never returns `undefined`. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

type RichPart = { type: "ui"; block: UiBlock } | { type: "image"; mimeType: string; data: string };

const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4);

const projectionText = (parts: RichPart[]): string =>
  parts
    .map((part) =>
      part.type === "ui"
        ? renderUiBlockText(part.block)
        : `[image: ${part.mimeType} (${base64Bytes(part.data)} bytes)]`,
    )
    .join("\n");

interface McpCallLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Maps an MCP `CallToolResult` into an Alisio `ToolResult`. Text/image parts map directly;
 * verified table/key-value/tree shapes (from `structuredContent` or JSON text parts) become
 * `ui` blocks; a canonical text projection is always appended when non-text parts exist, and
 * unrecognized results keep the previous `JSON.stringify` flattening verbatim.
 */
export function mapMcpCallResult(result: unknown): ToolResult {
  const raw = (result ?? {}) as McpCallLike;
  const parts = Array.isArray(raw.content) ? raw.content : [];
  if (!parts.length && raw.structuredContent === undefined)
    return textResult(JSON.stringify(result), raw.isError === true);
  const content: Array<{ type: "text"; text: string } | RichPart> = [];
  const rich: RichPart[] = [];
  const keepSourceOrder = (part: RichPart) => {
    rich.push(part);
    content.push(part);
  };
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = record.type;
    if (type === "text") {
      const text =
        typeof record.text === "string" ? record.text : JSON.stringify(record.text ?? "");
      const block = blockFromJsonText(text);
      if (block) keepSourceOrder({ type: "ui", block });
      else content.push({ type: "text", text });
    } else if (type === "image") {
      const data = typeof record.data === "string" ? record.data : "";
      if (data)
        keepSourceOrder({
          type: "image",
          mimeType:
            typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream",
          data,
        });
    } else {
      // Audio / embedded resource / unknown part: never forward raw bytes; a marker keeps the model informed.
      content.push({ type: "text", text: `[mcp part: ${type}]` });
    }
  }
  const structured = blockFromUnknown(raw.structuredContent);
  if (structured) keepSourceOrder({ type: "ui", block: structured });
  if (rich.length) content.push({ type: "text", text: projectionText(rich) });
  if (!content.length) return textResult(JSON.stringify(result), raw.isError === true);
  return { content, ...(raw.isError === true ? { isError: true } : {}) };
}

interface McpResourceContentsLike {
  uri?: unknown;
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
}

/**
 * Maps an MCP `ReadResourceResult` / `ListResourcesResult` into an Alisio `ToolResult`.
 * Text contents map to text parts; image blobs become `{type:"image"}` parts; non-image blobs
 * become a text marker (never raw base64 in the model prompt). Results without contents (a
 * resource listing, for example) keep the previous `JSON.stringify` flattening.
 */
export function mapMcpResourceResult(result: unknown): ToolResult {
  const raw = (result ?? {}) as { contents?: unknown };
  const contents = Array.isArray(raw.contents) ? raw.contents : [];
  if (!contents.length)
    return textResult(
      JSON.stringify(result),
      typeof result === "object" &&
        result !== null &&
        (result as { isError?: unknown }).isError === true,
    );
  const content: Array<{ type: "text"; text: string } | RichPart> = [];
  const rich: RichPart[] = [];
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const record = item as McpResourceContentsLike;
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream";
    if (typeof record.text === "string") {
      const block = blockFromJsonText(record.text);
      if (block) {
        rich.push({ type: "ui", block });
        content.push({ type: "ui", block });
      } else content.push({ type: "text", text: record.text });
    } else if (typeof record.blob === "string") {
      if (mimeType.startsWith("image/")) {
        const image: RichPart = { type: "image", mimeType, data: record.blob };
        rich.push(image);
        content.push(image);
      } else
        content.push({
          type: "text",
          text: `[resource blob: ${mimeType} (${base64Bytes(record.blob)} bytes)]`,
        });
    }
  }
  if (rich.length) content.push({ type: "text", text: projectionText(rich) });
  if (!content.length)
    return textResult(
      JSON.stringify(result),
      typeof result === "object" &&
        result !== null &&
        (result as { isError?: unknown }).isError === true,
    );
  return { content };
}
