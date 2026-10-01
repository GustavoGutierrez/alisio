/**
 * The bundled `create-agent` skill: agent-authoring standards the ACTIVE model follows when it
 * writes or refines an agent's instructions (assisted creation in the web Agents window and the
 * TUI `/agents` manager). A user or project skill named `create-agent` (or `agent-creator`)
 * replaces it, so teams can encode their own conventions.
 */

/** Skill names that override the bundled guidance, in order of preference. */
export const AGENT_AUTHORING_SKILL_NAMES = ["create-agent", "agent-creator"] as const;

export const CREATE_AGENT_SKILL = `---
name: create-agent
description: Standards for writing the system prompt (instructions) of an Alisio agent.
---
# Writing agent instructions

An agent's instructions are its system prompt. They are read on every turn, so every line must
earn its place. Write them in Markdown, in the second person ("You ..."), in English unless the
user asks otherwise.

## Required sections

1. **Role** — one or two sentences: who the agent is and who it serves.
2. **Goal** — the outcome a successful turn produces, stated so it can be checked.
3. **Scope** — what the agent handles and, explicitly, what it must decline or hand back.
4. **How to work** — an ordered method for the typical task (investigate, act, verify, report).
5. **Tool usage** — when to read, search, edit or run processes; prefer reading before editing;
   verify changes (tests, type checks) before claiming success; ask before destructive,
   irreversible or external actions (deleting data, deploying, spending money, contacting people).
6. **Constraints** — hard rules: safety, privacy, secrets never echoed, repository conventions,
   performance or style limits. Phrase them as testable rules, not vague values.
7. **Output format** — the exact shape of the final answer (headings, lists, tables, JSON keys,
   length). Match the agent's text format setting.
8. **Examples** (optional) — one short input → output pair when the format or tone is unusual.

## Quality bar

- Be specific to the described job; remove generic filler ("be helpful", "be accurate").
- Prefer short imperative bullets over paragraphs. Target 150–600 words.
- Never invent tools, files, APIs or data the agent does not have; tell it to say when it lacks
  information instead of guessing.
- Keep the agent honest: report what was verified and what was not.
- When refining an existing definition, keep what already works, apply the user's requested
  changes, and fill any missing required section.

## Settings to suggest

- Reasoning effort: \`high\` for analysis, debugging, security or multi-step refactors; \`medium\`
  for general engineering; \`low\` for formatting, summaries and support replies.
- Reasoning summary: \`auto\` by default; \`none\` for short conversational agents; \`detailed\` when
  the user audits the reasoning.
- Verbosity: \`low\` for terse operational agents, \`medium\` by default, \`high\` for reports.
- Text format: \`text\` unless the agent must return machine-readable output (\`json_object\`,
  or \`json_schema\` when a strict schema is given).
`;

/** The skill body without the loader preamble and frontmatter (what is sent as guidance). */
export function skillBody(text: string): string {
  return text
    .replace(/^Skill root:.*\r?\n(?:Use skill_resource.*\r?\n)?/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "")
    .trim();
}
