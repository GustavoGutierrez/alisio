/**
 * The starter template every creator project begins from. It is the generated-plugin contract in
 * runnable form: plain ESM JavaScript (JSDoc types only), no build step, no runtime dependencies,
 * `@alisio/sdk` as an optional peer only (nothing imports it at runtime, so the plugin loads and
 * its tests run without installing anything), and `node:test` tests over a tiny fake `PluginAPI`.
 *
 * The version lives only in `package.json`: `src/index.js` reads it, so bumping a version is a
 * one-line change.
 */

export interface TemplateInput {
  packageName: string;
  pluginId: string;
  displayName: string;
  description: string;
  /** `peerDependencies["@alisio/sdk"]`, e.g. `^0.11.0`. */
  sdkRange: string;
}

import { TEMPLATE_EXAMPLE_MARKER } from "./validate.ts";

const json = (value: unknown) => JSON.stringify(value);

/** Where the scaffold puts the images (`package.json` → `alisio.icon` / `alisio.cover`). */
export const ICON_PATH = "assets/icon.svg";
export const COVER_PATH = "assets/cover.svg";
/** Characters of the display name the cover shows before it is shortened with "…". */
export const COVER_TITLE_CHARS = 40;

export const xmlEscape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** A 64x64 placeholder icon (the same square format as the default plugin icon). */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Plugin">
  <rect width="64" height="64" rx="14" fill="#2f6fde"/>
  <path d="M24 14h6v8h4v-8h6v8h4a4 4 0 0 1 4 4v6h-8v6h8v6a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4h4z" fill="#fff"/>
</svg>
`;

/**
 * A 1280x720 (16:9, the catalog card ratio) placeholder cover with the display name, XML-escaped
 * and shortened to fit: the font shrinks for longer names and anything past
 * `COVER_TITLE_CHARS` characters is cut with "…".
 */
export function coverSvg(displayName: string): string {
  const name = [...displayName.replace(/\s+/g, " ").trim()];
  const shown =
    name.length > COVER_TITLE_CHARS
      ? `${name.slice(0, COVER_TITLE_CHARS - 1).join("")}…`
      : name.join("");
  const size = shown.length <= 18 ? 96 : shown.length <= 28 ? 72 : 52;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720" role="img" aria-label="${xmlEscape(shown)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e3a8a"/>
      <stop offset="1" stop-color="#2f6fde"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <circle cx="1120" cy="140" r="220" fill="#fff" opacity=".08"/>
  <text x="640" y="380" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="${size}" fill="#fff">${xmlEscape(shown)}</text>
</svg>
`;
}

function packageJson(input: TemplateInput): string {
  return `${JSON.stringify(
    {
      name: input.packageName,
      version: "1.0.0",
      description: input.description,
      type: "module",
      license: "UNLICENSED",
      keywords: ["alisio-plugin", "alisio-private-plugin"],
      exports: { ".": "./src/index.js" },
      files: ["src", "assets", "README.md"],
      scripts: { test: "node --test test/" },
      peerDependencies: { "@alisio/sdk": input.sdkRange },
      peerDependenciesMeta: { "@alisio/sdk": { optional: true } },
      alisio: { pluginId: input.pluginId, icon: ICON_PATH, cover: COVER_PATH },
    },
    null,
    2,
  )}\n`;
}

function indexJs(input: TemplateInput): string {
  return `/**
 * ${input.displayName.replace(/\*\//g, "* /")}
 *
 * Plain ESM JavaScript with JSDoc types: no build step and nothing imported from "@alisio/sdk" at
 * runtime (it is an optional peer), so the plugin loads without installing any package.
 */
import { createRequire } from "node:module";

/** The one source of the version: package.json. */
const { version } = createRequire(import.meta.url)("../package.json");

export const PLUGIN_ID = ${json(input.pluginId)};

/**
 * A tool result with one text part (what \`textResult\` of "@alisio/sdk" returns).
 * @param {string} text
 * @param {boolean} [isError]
 * @returns {import("@alisio/sdk").ToolResult}
 */
export function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** @type {import("@alisio/sdk").Plugin} */
const plugin = {
  id: PLUGIN_ID,
  version,
  apiVersion: 1,
  name: ${json(input.displayName)},
  description: ${json(input.description)},
  categories: ["tools"],
  setup(api) {
    // ${TEMPLATE_EXAMPLE_MARKER}: replace this example tool with what the person asked for.
    api.tools.register({
      name: "greet",
      description: "Greets a person by name.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "The person's name." } },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(input) {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) return textResult("Please tell me the name of the person to greet.", true);
        return textResult(\`Hello, \${name}!\`);
      },
    });
  },
};

export default plugin;
`;
}

export const PLUGIN_HARNESS_JS = `/**
 * A tiny fake of the Alisio PluginAPI for node:test. It records what the plugin registers and
 * lets a test call a tool the way Alisio would. \`storage.sqlite()\` is a real in-memory SQLite
 * database (node:sqlite), so storage code is tested for real. Not part of the published package.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Wraps node:sqlite's DatabaseSync into the SqlDatabase port of the PluginAPI. */
function memoryDatabase() {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const statements = new Map();
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
      return statements.get(sql);
    },
    transaction(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}

const SCHEMA_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "description", "title", "enum",
  "const", "default", "examples", "items", "minItems", "maxItems", "uniqueItems", "minLength",
  "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "anyOf", "oneOf", "allOf", "not", "minProperties", "maxProperties", "$schema",
]);

/**
 * The rules Alisio's host enforces on a tool inputSchema (Ajv strict mode), checked the same way
 * here so a test fails before the build does. Throws with the path of the first problem.
 */
export function checkSchema(schema, path = "#") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error(\`inputSchema \${path} must be an object\`);
  if (Array.isArray(schema.type))
    throw new Error(\`inputSchema \${path}: type arrays are not allowed (use one type and parse the value)\`);
  for (const key of Object.keys(schema))
    if (!SCHEMA_KEYWORDS.has(key)) throw new Error(\`inputSchema \${path}: keyword "\${key}" is not allowed\`);
  const needs = { minimum: "number", maximum: "number", exclusiveMinimum: "number", exclusiveMaximum: "number",
    multipleOf: "number", minLength: "string", maxLength: "string", pattern: "string", items: "array",
    minItems: "array", maxItems: "array", required: "object", properties: "object" };
  for (const [key, type] of Object.entries(needs))
    if (key in schema && schema.type !== type && !(type === "number" && schema.type === "integer"))
      throw new Error(\`inputSchema \${path}: "\${key}" needs type "\${type}"\`);
  for (const name of schema.required ?? [])
    if (!(name in (schema.properties ?? {})))
      throw new Error(\`inputSchema \${path}: required "\${name}" is not in properties\`);
  for (const [name, child] of Object.entries(schema.properties ?? {})) checkSchema(child, \`\${path}/properties/\${name}\`);
  if (schema.items) checkSchema(schema.items, \`\${path}/items\`);
  for (const key of ["anyOf", "oneOf", "allOf"])
    for (const [i, child] of (schema[key] ?? []).entries()) checkSchema(child, \`\${path}/\${key}/\${i}\`);
}

/**
 * @param {{ options?: Record<string, unknown> }} [init]
 */
export function createFakeApi(init = {}) {
  const tools = new Map();
  const commands = new Map();
  const views = new Map();
  const apps = new Map();
  const state = new Map();
  const databases = [];
  const noop = () => () => {};
  const api = {
    tools: {
      register(tool) {
        if (tools.has(tool.name)) throw new Error(\`Tool registered twice: \${tool.name}\`);
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error(\`Invalid tool name: \${tool.name}\`);
        if (tool.inputSchema?.type !== "object") throw new Error("A tool inputSchema must be { type: \\"object\\" }");
        checkSchema(tool.inputSchema);
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    commands: {
      register(name, handler, options) {
        commands.set(name, { handler, options });
        return () => commands.delete(name);
      },
    },
    views: {
      register(view) {
        views.set(view.id, view);
        return () => views.delete(view.id);
      },
    },
    // A screen in the Apps menu. Checked like Alisio's host does (id, html, action schemas).
    apps: {
      register(app) {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(app?.id ?? "")) throw new Error(\`Invalid app id: \${app?.id}\`);
        if (apps.has(app.id)) throw new Error(\`App registered twice: \${app.id}\`);
        if (typeof app.html !== "function") throw new Error("An app needs an html function");
        for (const [name, action] of Object.entries(app.actions ?? {})) {
          if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error(\`Invalid app action name: \${name}\`);
          if (!["read", "write", "process"].includes(action?.effect))
            throw new Error(\`App action \${name} needs an effect of read, write or process\`);
          if (typeof action.handler !== "function") throw new Error(\`App action \${name} needs a handler\`);
          if (action.inputSchema?.type !== "object")
            throw new Error(\`App action \${name} inputSchema must be { type: "object" }\`);
          checkSchema(action.inputSchema);
        }
        apps.set(app.id, app);
        return () => {
          if (apps.get(app.id) === app) apps.delete(app.id);
          app.dispose?.();
        };
      },
    },
    events: { on: noop },
    context: { register: noop },
    compaction: { register: noop },
    session: { onStart: noop, onEnd: noop },
    resources: { skills() {}, prompts() {}, agents() {}, list: () => [] },
    state: { get: (key) => state.get(key), set: (key, value) => state.set(key, value) },
    storage: {
      sqlite() {
        const db = memoryDatabase();
        databases.push(db);
        return db;
      },
    },
    options: init.options ?? {},
    // Fake folders: storage.sqlite() ignores the path and opens an in-memory database.
    paths: { state: "/fake/state", config: "/fake/config", cache: "/fake/cache" },
    ui: {
      status() {},
      panel: noop,
      select: async () => undefined,
      askQuestions: async () => ({}),
      open: () => false,
      interactive: () => false,
    },
    extensions: { register: noop },
  };
  return {
    api,
    tools,
    commands,
    views,
    apps,
    state,
    /** The page of a registered app (what \`html()\` returns). */
    async appHtml(id) {
      const app = apps.get(id);
      if (!app) throw new Error(\`No app named \${id}\`);
      return app.html();
    },
    /** Runs an action of a registered app the way the app's page calls it through Alisio. */
    async callAppAction(id, name, input = {}, context = {}) {
      const action = apps.get(id)?.actions?.[name];
      if (!action) throw new Error(\`No action \${name} in the app \${id}\`);
      return action.handler(input, {
        sessionId: "test-session",
        workspace: process.cwd(),
        signal: new AbortController().signal,
        ...context,
      });
    },
    /** Runs a registered tool like Alisio does. */
    async callTool(name, input = {}, context = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(\`No tool named \${name}\`);
      return tool.execute(input, {
        workspace: process.cwd(),
        signal: new AbortController().signal,
        ...context,
      });
    },
    /** Runs a registered slash command. */
    async runCommand(name, args = "") {
      const command = commands.get(name);
      if (!command) throw new Error(\`No command named \${name}\`);
      return command.handler(args);
    },
    close() {
      for (const db of databases) db.close();
    },
  };
}

/** The text of a tool result (its text parts joined). */
export function textOf(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\\n");
}
`;

function pluginTestJs(): string {
  return `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import plugin, { PLUGIN_ID } from "../src/index.js";
import { createFakeApi, textOf } from "./harness.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the plugin manifest matches package.json", () => {
  assert.equal(plugin.id, PLUGIN_ID);
  assert.match(plugin.id, /^[a-z0-9][a-z0-9.-]{0,63}$/);
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.apiVersion, 1);
});

test("setup registers the greet tool", async () => {
  const fake = createFakeApi();
  await plugin.setup(fake.api);
  assert.deepEqual([...fake.tools.keys()], ["greet"]);
  assert.equal(fake.tools.get("greet").effect, "read");
});

test("greet answers with the name", async () => {
  const fake = createFakeApi();
  await plugin.setup(fake.api);
  assert.equal(textOf(await fake.callTool("greet", { name: "Ana" })), "Hello, Ana!");
});

test("greet explains a missing name in plain words", async () => {
  const fake = createFakeApi();
  await plugin.setup(fake.api);
  const result = await fake.callTool("greet", { name: "  " });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /name/);
});
`;
}

function readme(input: TemplateInput): string {
  return `# ${input.displayName}

${input.description}

A private Alisio plugin made with the Alisio plugin creator.

## What it does

- (describe each tool or command in one plain sentence)

## Develop

- \`node --test test/\` runs the tests (no install needed).
- The version lives in \`package.json\` only.
`;
}

/** Project-relative path -> file text of a new creator project. */
export function pluginTemplateFiles(input: TemplateInput): Record<string, string> {
  return {
    "package.json": packageJson(input),
    "README.md": readme(input),
    [ICON_PATH]: ICON_SVG,
    [COVER_PATH]: coverSvg(input.displayName),
    "src/index.js": indexJs(input),
    "test/harness.js": PLUGIN_HARNESS_JS,
    "test/plugin.test.js": pluginTestJs(),
  };
}
