/**
 * The bundled `alisio-plugin-creator` skill (progressive disclosure: a short SKILL.md index plus
 * references and templates). It ships inside the core as source text, so it survives the build,
 * `npm pack` and the standalone binary without any asset copying, and is materialized under the
 * config home for creator sessions (`skill.ts`). Edit the Markdown here directly.
 */

export const PLUGIN_CREATOR_SKILL_NAME = "alisio-plugin-creator";

/** Skill-relative path -> file text. */
export const PLUGIN_CREATOR_SKILL_FILES: Readonly<Record<string, string>> = {
  "SKILL.md": `---
name: alisio-plugin-creator
description: "Build a small, robust Alisio plugin for a non-technical person inside a plugin creator project: plain ESM JavaScript, no dependencies, @alisio/sdk as an optional peer, node:test tests first (TDD), friendly EN/ES messages, validated and packaged with the plugin_project tools. Use this skill in every plugin creator session, before writing or changing any file of the project."
---

# Alisio plugin creator

You are building a private Alisio plugin in the current workspace (the project folder). The
person asking is not a programmer: they describe a need; you deliver a plugin that works.

## Workflow (report each step with \`plugin_project\` action \`progress\`)

1. **plan**: restate the need in one or two plain sentences; decide the tools/commands. If the
   request is ambiguous, ask ONE short question and stop. Details: references/workflow.md
2. **tests**: write failing \`node:test\` tests first in \`test/*.test.js\` using \`test/harness.js\`.
   Recipe: references/testing.md
3. **code**: write the smallest code that passes, in \`src/\`. API: references/sdk-cheatsheet.md
4. **run_tests**: \`plugin_project_run\` action \`test\`; fix until green.
5. **package**: \`plugin_project_run\` action \`build\` (validate, test, probe, pack). Fix every issue.

Then tell the person, in plain words, what the plugin does and that they can press
"Install & enable". You never install it yourself.

## Hard rules (the build refuses violations)

- Plain ESM JavaScript (\`.js\`), JSDoc types only. No TypeScript, no build step.
- No dependencies and no runtime import of any package, \`@alisio/sdk\` or \`@alisio/core\`
  included: only relative files and \`node:\` built-ins. \`@alisio/sdk\` stays an optional peer.
- The version lives only in \`package.json\`; on a change request bump the patch (1.0.0 -> 1.0.1).
- Keep \`name\`, \`alisio.pluginId\`, \`exports\` and \`files\` as created. No install scripts.
- Work only inside this folder. Never touch files outside it.
- At least one meaningful test per tool or command; tests never use the network.
- Minimal: the scaffold has only the core (manifest, entry with one example tool, tests, README,
  icon, cover). Add storage, commands, views, hooks, EN/ES strings or settings ONLY when the request
  needs them, from the templates below. No unused code, files, effects/permissions or manifest
  entries; replace the example \`greet\` tool. \`validate\` warns on dead weight: fix every warning.
- Compatible with the INSTALLED Alisio: keep the \`@alisio/sdk\` peer range as created (the build
  fails when it does not accept the running SDK) and use only PluginAPI members from
  references/sdk-cheatsheet.md (the build runs setup against the real API shape).
- Keep \`assets/icon.svg\` and \`assets/cover.svg\`. Replace them with your own SVG only if you can
  draw clean, small, safe SVG (references/visuals.md); otherwise keep the placeholders.

## References (load only what the task needs)

| File | Use it for |
|---|---|
| references/workflow.md | Steps, progress reports, asking questions, change requests |
| references/sdk-cheatsheet.md | Plugin object, tools, commands, views, state, storage, options |
| references/testing.md | TDD with \`test/harness.js\`, what to test, common failures |
| references/quality-checklist.md | Check before running the build |
| references/ux-copy.md | Messages for non-technical people, EN/ES |
| references/storage.md | SQLite tables, schema, migrations |
| references/patterns.md | Patterns that keep plugins small and fast to build |
| references/visuals.md | Icon and cover: formats, sizes, safe SVG rules |
| templates/storage-tool.js | A tool that saves and lists records in SQLite |
| templates/storage.test.js | Tests for that tool with the in-memory database |
| templates/command.js | A slash command with a friendly answer |
| templates/i18n.js | EN/ES strings, only when the plugin talks to people in both languages |
`,
  "references/patterns.md": `# Patterns that keep plugins small, robust and fast to build

- **Pure core, thin tool.** Put the logic in pure functions (\`src/logic.js\`: parse, calculate,
  format) and keep \`execute\` to: validate input -> call logic -> format a result. Pure functions
  are trivial to test with table-driven cases.
- **One validator per tool.** A small \`readInput(input, lang)\` that returns \`{ ok, value }\` or
  \`{ ok: false, message }\`; the tool returns the message as an error result.
- **Lazy resources.** Open databases or read files on first use, not in \`setup\` (setup stays fast
  and never fails because of data).
- **Bounded outputs.** Cap lists (\`LIMIT 50\`) and long texts; say how many were left out.
- **Deterministic time.** Accept an optional \`date\` input or inject \`now\` so tests are stable.
- **Copy, don't invent.** Start from \`templates/storage-tool.js\`, \`templates/command.js\` and
  the template's \`greet\` tool; keep their structure.
- **Few files.** \`src/index.js\` (registration), \`src/i18n.js\`, optional \`src/logic.js\` and
  \`src/schema.js\`. More files only when one passes ~300 lines.
- **Fail soft.** Expected problems return friendly error results; an unexpected throw is a bug.
`,
  "references/quality-checklist.md": `# Quality checklist (run before the build)

Issue codes the validator/build reports, and the fix:

| Code | Fix |
|---|---|
| \`type_not_module\` | \`"type": "module"\` in package.json |
| \`dependencies_forbidden\` | Remove dependencies; write the code with Node built-ins |
| \`peer_sdk_missing\` / \`peer_extra\` | peerDependencies has exactly \`"@alisio/sdk"\` |
| \`lifecycle_scripts_forbidden\` | Remove preinstall/install/postinstall/prepare scripts |
| \`entry_missing\` / \`entry_not_packed\` | \`exports["."]\` points at \`./src/index.js\`, and \`files\` includes \`src\` |
| \`forbidden_import\` | Only \`./relative.js\` files and \`node:\` modules at runtime |
| \`tests_missing\` | Add \`test/<name>.test.js\` |
| \`version_mismatch\` | Read the version from package.json (as the template does) |
| \`plugin_id_invalid\`, \`api_version_invalid\`, \`setup_missing\`, \`load_failed\` | Fix the default export object |
| \`asset_missing\`, \`asset_outside\`, \`asset_not_packed\`, \`asset_format\`, \`asset_too_large\` | Keep \`alisio.icon\`/\`alisio.cover\` pointing at a valid image under \`assets/\` (see visuals.md) |
| \`svg_unsafe\` | Remove scripts, \`on...\` attributes, \`foreignObject\`, \`<image>\` and outside links from the SVG |
| \`sdk_incompatible\` | Put back the created \`@alisio/sdk\` range: it must accept the installed SDK |
| \`engine_unsupported\`, \`engine_unknown\` | Remove \`engines\` (or keep only a \`node\` range the running Node satisfies) |
| \`api_member_unknown\` | Use only members listed in sdk-cheatsheet.md; the installed SDK has no such member |
| \`unused_file\`, \`empty_file\`, \`template_example\`, \`registers_nothing\` (warnings) | Delete dead files, replace the example tool, register what the plugin offers |
| \`symlink_forbidden\`, \`file_too_large\`, \`project_too_large\`, \`too_many_files\` | Keep the plugin small and plain |

Before the build, also check:

- [ ] Nothing unused: no file, function, string, effect, permission or manifest entry that the
      plugin does not need for this request.

- [ ] Every tool has a precise description, a strict \`inputSchema\` (\`additionalProperties: false\`) and an honest \`effect\`.
- [ ] Inputs are validated; bad input returns a friendly message (EN/ES), never a stack trace.
- [ ] No secrets, tokens or personal data in code, logs or results.
- [ ] Results are short; long lists are capped (for example the last 50 items).
- [ ] Resources (databases, timers) are opened lazily and closed in \`dispose\`.
- [ ] README explains what the plugin does in plain words; package.json \`description\` is one sentence.
- [ ] Version bumped (patch) if this was a change request.
`,
  "references/sdk-cheatsheet.md": `# SDK cheat sheet (\`@alisio/sdk\`, apiVersion 1)

Types only (JSDoc \`import("@alisio/sdk").X\`); never import the package at runtime. This is the
full PluginAPI of the installed SDK: the build runs \`setup\` against exactly this shape and fails
on any other member (\`api_member_unknown\`). Feature-detect optional members with \`?.\`.

## The plugin object (default export of \`src/index.js\`)

\`\`\`js
/** @type {import("@alisio/sdk").Plugin} */
export default {
  id: "local.my-plugin-ab12",   // keep the created id: ^[a-z0-9][a-z0-9.-]{0,63}$
  version,                       // read from package.json (see src/index.js)
  apiVersion: 1,
  name: "My plugin",
  description: "One plain sentence.",
  categories: ["tools"],         // tools | storage | analytics | ui | ...
  async setup(api) { /* register everything here */ },
  async dispose() { /* optional: close resources on exit */ },
};
\`\`\`

\`setup\` failing rolls back what it registered. Every \`register\` returns an unregister function.

## Tools (what the model can call)

\`\`\`js
api.tools.register({
  name: "add_expense",                 // snake_case, unique in the plugin
  description: "Saves an expense with amount and category.", // the model reads this: be precise
  effect: "write",                     // read | write | process | external
  inputSchema: { type: "object", properties: { ... }, required: [...], additionalProperties: false },
  async execute(input, context) {      // context: { workspace, session?, signal }
    return textResult("Saved.");       // { content: [{ type: "text", text }], isError? }
  },
});
\`\`\`

- \`effect\`: \`read\` only when nothing changes; writes to its own storage are \`write\`; running
  programs is \`process\`; network is \`external\`. Undeclared = \`external\`. The person approves
  non-read effects; an honest effect matters.
- Validate \`input\` yourself (the schema helps the model, it is not a guarantee).
- Return errors as \`textResult(message, true)\` with a friendly message; do not throw for
  expected problems (missing data, wrong format). Throw only for real bugs.
- Results go back to the model: keep them short; JSON text is fine for lists.

## Commands (slash commands the person types)

\`\`\`js
api.commands.register("summary", async (args) => "text answer", {
  description: "Shows this month's summary", argumentHint: "[month]",
});
\`\`\`

Shown as \`/<plugin-id>:summary\`. The handler returns the text to show.

## Other API (feature-detect the optional ones with \`?.\`)

| Need | API |
|---|---|
| Small key/value state | \`api.state.get(key)\`, \`api.state.set(key, value)\` (JSON values) |
| A private SQLite database | \`api.storage.sqlite(join(api.paths.state, "data.sqlite"))\` -> \`{ exec, prepare(sql).run/get/all, transaction(fn), close }\` |
| Per-plugin folders | \`api.paths?.state\`, \`api.paths?.config\`, \`api.paths?.cache\` (absent on old hosts) |
| User options | \`api.options?.myKey\` (read-only, set by the person in config) |
| Read-only data for the web | \`api.views?.register({ id, description, params?, handler })\` |
| Extra model context | \`api.context.register(async () => "text")\` (keep it tiny) |
| Ask the person | \`api.ui.select(...)\`, \`api.ui.askQuestions(...)\` (resolve \`undefined\` when headless) |
| Run events | \`api.events.on((event) => {})\` (ignore unknown types) |

Not available to these plugins: provider SDKs, \`@alisio/core\`, other plugins, \`internal\` effect,
artifacts. Plugins run in-process with the person's privileges: nothing here is a sandbox.
`,
  "references/storage.md": `# Storage

Use \`api.state\` for a few small values (settings, a counter). Use SQLite for records.

## Opening the database (lazily, once)

\`\`\`js
import { join } from "node:path";
let db;
function database(api) {
  if (db) return db;
  if (!api.paths) throw new Error("This Alisio version is too old for this plugin");
  db = api.storage.sqlite(join(api.paths.state, "data.sqlite"));
  db.exec(SCHEMA);
  return db;
}
\`\`\`

Close it in \`dispose()\` (\`db?.close(); db = undefined;\`).

## Schema

- Keep the whole schema in one \`src/schema.js\` constant with \`CREATE TABLE IF NOT EXISTS\`.
  The creator shows these tables to the person as a diagram: name tables and columns in plain
  English (\`expenses\`, \`amount_cents\`, \`created_at\`).
- Every table has \`id INTEGER PRIMARY KEY\`; relations use \`REFERENCES other(id)\`.
- Store money as integer cents, dates as ISO text (\`2026-01-31\`) or epoch milliseconds.
- Always use parameters: \`db.prepare("INSERT INTO expenses (amount_cents, category) VALUES (?, ?)").run(1250, "food")\`.
  Never build SQL from input text.

## Changing the schema in a later version

- Only add: new tables, or \`ALTER TABLE ... ADD COLUMN\` with a default. Never drop or rename data.
- Track the version with \`PRAGMA user_version\`:

\`\`\`js
const MIGRATIONS = [SCHEMA_V1, "ALTER TABLE expenses ADD COLUMN note TEXT DEFAULT ''"];
const current = Number(db.prepare("PRAGMA user_version").get().user_version);
db.transaction(() => {
  for (let v = current; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
  db.exec(\`PRAGMA user_version = \${MIGRATIONS.length}\`);
});
\`\`\`

- Test the migration: create the old schema in the in-memory database, run setup, read old rows.
`,
  "references/testing.md": `# Testing (TDD with node:test)

Tests live in \`test/<name>.test.js\` and run with \`plugin_project_run\` \`{action: "test"}\`
(\`node --test\`, no install). \`test/harness.js\` is a fake PluginAPI: keep it, do not ship it.

## Recipe

1. Write the test for the behavior the person asked for. Run it: it must FAIL for the right
   reason (the tool does not exist yet, or answers wrong).
2. Write the minimum code to pass. Run again.
3. Refactor only while green.

\`\`\`js
import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/index.js";
import { createFakeApi, textOf } from "./harness.js";

test("add_expense saves and confirms in Spanish", async () => {
  const fake = createFakeApi();
  await plugin.setup(fake.api);
  const result = await fake.callTool("add_expense", { amount: 12.5, category: "food", language: "es" });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /guardado/i);
  fake.close();
});
\`\`\`

Harness: \`createFakeApi({ options })\` -> \`{ api, tools, commands, views, state, callTool(name,
input, context?), runCommand(name, args), close() }\`; \`api.storage.sqlite()\` is a real in-memory
SQLite (node:sqlite), \`api.paths\` points at fake folders. \`textOf(result)\` joins text parts.

## What to test (minimal but meaningful)

- Keep the manifest test (\`id\`, \`version\` equals package.json, \`apiVersion: 1\`).
- Each tool: the main success case, and one bad-input case that returns a friendly error.
- Each command: its answer for a normal call.
- Storage: write then read back; the empty state.
- Pure helpers (parsing, calculations): a few table-driven cases, including edge values.
- Do NOT test: the harness itself, string constants verbatim, implementation details.

## Common failures

- \`Cannot find package\`: a runtime import of a package; use Node built-ins only.
- Hanging test: an open timer or database; call \`fake.close()\` and avoid \`setInterval\`.
- Dates: pass the date in (or a \`now\` function) instead of reading the clock in assertions.
- Floating point money: work in cents (integers).
`,
  "references/ux-copy.md": `# Messages for non-technical people

The person reads two kinds of text: your chat messages and the plugin's own messages.

## Your chat messages (in the person's language)

- Short sentences, no jargon: say "the plugin", "a test", "the package", not "ESM", "TAP", "tgz".
- Progress: "I'm writing the checks first, then the plugin." / "Estoy escribiendo primero las pruebas y luego el plugin."
- Done: what it does, one example of how to ask for it, and "Press Install & enable to use it." / "Pulsa Instalar y activar para usarlo."
- Problems: what happened and what you will do next; never paste raw errors.

## The plugin's messages

- Plain English strings inline are enough for a simple plugin. When the person works in Spanish
  or asks for both languages, add \`src/i18n.js\` from \`templates/i18n.js\`: every user-facing
  string goes through \`t(lang, key, vars)\` with both \`en\` and \`es\`, and an optional \`language\`
  input picks the language (\`pickLanguage\`), default English.
- Errors say what is missing and how to fix it: "Please give the amount as a number, for example 12.50."
  / "Indica el importe como número, por ejemplo 12,50."
- Confirmations repeat the key facts: "Saved: 12.50 for food." / "Guardado: 12,50 en comida."
- Numbers and dates: format with \`Intl.NumberFormat(lang)\` / \`toLocaleDateString(lang)\`.
- Never blame the person; never show stack traces, paths or codes.
`,
  "references/visuals.md": `# Icon and cover

The project starts with placeholders, declared in \`package.json\` → \`alisio.icon\` and \`alisio.cover\`:

| Image | File | Format | Size cap | Shape |
|---|---|---|---|---|
| Icon | \`assets/icon.svg\` | SVG, PNG, WebP or JPEG (checked by content) | 256 KB | square, \`viewBox="0 0 64 64"\` |
| Cover | \`assets/cover.svg\` | same | 512 KB | 16:9, \`viewBox="0 0 1280 720"\` |

Both must stay inside the plugin and inside \`files\` (\`assets\`). Alisio shows the icon in the
plugin lists today; the cover is kept for the catalog card format.

## Replacing them (optional)

Only when you can draw clean SVG: design a simple icon (one bold symbol on a solid or two-stop
gradient background) and a cover (the plugin name as text plus one or two shapes). Otherwise
keep the placeholders; they are fine. Rules the validator enforces (\`svg_unsafe\`):

- No \`<script>\`, no \`on...=\` attributes, no \`<foreignObject>\`, no \`<image>\`.
- No external references: every \`href\`/\`xlink:href\` and \`url(...)\` points at \`#an-id\` inside the
  file; no \`@import\`, no \`<!ENTITY>\`.
- Keep it small: a few shapes, short path data (integers, relative commands), no metadata,
  comments or editor attributes. Aim for under 4 KB for the icon and 12 KB for the cover.
- Text on the cover: escape \`&\`, \`<\`, \`>\` and quotes; keep the name to about 40 characters and
  lower \`font-size\` for long names so it fits in 1280 px.

Run \`plugin_project\` \`{action: "validate"}\` after changing an image.
`,
  "references/workflow.md": `# Workflow

## Tools you have

| Tool | Effect | What it does |
|---|---|---|
| \`plugin_project\` \`{action: "progress", step, status, note?}\` | internal | Shows the person where you are. Steps: \`plan\`, \`tests\`, \`code\`, \`run_tests\`, \`package\`; status \`running\`, \`done\` or \`failed\`. \`note\`: one short plain sentence. |
| \`plugin_project\` \`{action: "validate"}\` | internal | Static checks (manifest, imports, size, tests present). Returns issues with stable codes. |
| \`plugin_project\` \`{action: "stats"}\` | internal | Files, size, version, last build, detected tables. |
| \`plugin_project_run\` \`{action: "test"}\` | process | Runs \`node --test\` on \`test/*.test.js\` (scrubbed env, time limit). |
| \`plugin_project_run\` \`{action: "build"}\` | process | Validate + test + load check + package (\`.tgz\`). |

Writing files goes through the normal approval of each change: that is expected.

## Steps

1. Mark \`plan\` running. Read \`package.json\`, \`src/index.js\`, \`test/plugin.test.js\`.
2. Decide the smallest set of tools/commands that meets the need. One tool per user action is
   usually right. Prefer \`effect: "read"\` when the tool changes nothing.
3. Ambiguity: if you cannot tell WHAT the plugin must do (not how), ask one short question in the
   person's language, offering 2-3 concrete options, and stop. Do not ask about technical choices.
4. Mark \`tests\` running; write the tests (they fail). Mark \`code\`; implement. Mark \`run_tests\`;
   run them. Mark \`package\`; run the build. Mark each step \`done\` (or \`failed\` with a note).
5. Replace the example \`greet\` tool and its tests unless the person asked for greetings.
6. Update \`README.md\` (what it does, in plain words) and the \`description\` in \`package.json\`.
7. Finish with a short summary for the person: what the plugin does, how to use it in a chat
   ("ask Alisio to ..."), and that "Install & enable" activates it.

## Change requests

- Read the current code and tests first; keep what works.
- Bump the patch version in \`package.json\` (\`0.1.3\` -> \`0.1.4\`). Never edit the version anywhere else.
- Add or adjust tests for the change before the code. Run the build at the end.

## When the build fails

- \`plugin_project_invalid\`: read each issue \`code\` and fix it (see quality-checklist.md).
- \`plugin_tests_failed\`: read the output tail, fix the code (or a wrong test), rerun.
- After two failed attempts on the same problem, simplify the design instead of patching.
`,
  "templates/command.js": `// Template: a slash command (shown as /<plugin-id>:summary) that answers in plain words.
/** @param {import("@alisio/sdk").PluginAPI} api */
export function registerSummaryCommand(api, { t }) {
  api.commands.register(
    "summary",
    async (args) => {
      const lang = /\\bes\\b/.test(args) ? "es" : "en";
      const count = Number(api.state.get("count") ?? 0);
      return t(lang, "summary", { count });
    },
    { description: "Shows a short summary", argumentHint: "[es]" },
  );
}
`,
  "templates/i18n.js": `// Template (opt-in): EN/ES strings. Add as src/i18n.js ONLY when the plugin shows messages to
// people in both languages; otherwise keep plain English strings inline.
const MESSAGES = {
  en: { saved: "Saved: {title}.", titleInvalid: "Please give a short title." },
  es: { saved: "Guardado: {title}.", titleInvalid: "Indica un título corto." },
};

/** "es" for any Spanish language tag, otherwise "en". */
export function pickLanguage(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("es") ? "es" : "en";
}

/** The message \`key\` in \`lang\` with \`{placeholders}\` filled in (falls back to English). */
export function t(lang, key, vars = {}) {
  const text = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return text.replace(/\\{(\\w+)\\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
`,
  "templates/storage-tool.js": `// Template: a tool pair that saves and lists records in the plugin's SQLite database.
// Copy into src/ and adapt names, columns and messages (add them to src/i18n.js).
import { join } from "node:path";

export const SCHEMA = \`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);\`;

/** @param {import("@alisio/sdk").PluginAPI} api */
export function registerItemTools(api, { textResult, t, pickLanguage, now = Date.now }) {
  let db;
  const database = () => {
    if (db) return db;
    if (!api.paths) throw new Error("This Alisio version is too old for this plugin");
    db = api.storage.sqlite(join(api.paths.state, "data.sqlite"));
    db.exec(SCHEMA);
    return db;
  };

  api.tools.register({
    name: "add_item",
    description: "Saves an item with a short title.",
    effect: "write",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, language: { type: "string", enum: ["en", "es"] } },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(input) {
      const lang = pickLanguage(input.language);
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title || title.length > 200) return textResult(t(lang, "titleInvalid"), true);
      database().prepare("INSERT INTO items (title, created_at) VALUES (?, ?)").run(title, now());
      return textResult(t(lang, "saved", { title }));
    },
  });

  api.tools.register({
    name: "list_items",
    description: "Lists the 50 most recent items.",
    effect: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const rows = database()
        .prepare("SELECT id, title, created_at FROM items ORDER BY id DESC LIMIT 50")
        .all();
      return textResult(JSON.stringify(rows));
    },
  });

  return () => {
    db?.close();
    db = undefined;
  };
}
`,
  "templates/storage.test.js": `// Template: tests for templates/storage-tool.js with the harness's in-memory SQLite.
import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/index.js";
import { createFakeApi, textOf } from "./harness.js";

test("add_item saves an item that list_items returns", async () => {
  const fake = createFakeApi();
  await plugin.setup(fake.api);
  const saved = await fake.callTool("add_item", { title: "Buy milk" });
  assert.equal(saved.isError, undefined);
  const rows = JSON.parse(textOf(await fake.callTool("list_items", {})));
  assert.deepEqual(
    rows.map((row) => row.title),
    ["Buy milk"],
  );
  fake.close();
});

test("add_item refuses an empty title with a friendly message", async () => {
  const fake = createFakeApi();
  await plugin.setup(fake.api);
  const result = await fake.callTool("add_item", { title: " ", language: "es" });
  assert.equal(result.isError, true);
  fake.close();
});
`,
};
