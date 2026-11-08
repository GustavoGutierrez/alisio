/** Skill names that override the bundled authoring guidance (project/user/plugin skills). */
export const SKILL_AUTHORING_SKILL_NAMES = ["alisio-skill-authoring"] as const;

/**
 * Bundled guidance for writing skills in the open Agent Skills format. It condenses the format's
 * authoring best practices and is sent as the system prompt of the Skill Builder. Keep it short:
 * it is paid on every draft.
 */
export const SKILL_AUTHORING_GUIDANCE = `# Writing an Agent Skill

A skill is a folder with a SKILL.md (YAML frontmatter + Markdown body) and optional files. The
model sees only each skill's name and description until it decides to load the skill, so the
description decides whether the skill is ever used.

## Name
- Lowercase letters, digits and single hyphens, at most 64 characters, for example "pdf-merger".
- Specific and descriptive. Never "helper", "utils", "tools", "data" or "files". Prefer an
  activity form such as "processing-pdfs" or "merging-spreadsheets".
- Never contain "anthropic" or "claude".

## Description (the most important line)
- At most 1024 characters, no angle brackets, ALWAYS third person ("Merges PDF files ..."), never
  "I can" or "You can".
- Say WHAT the skill does and WHEN to use it: finish with "Use when ..." followed by concrete
  situations, file types and phrases a user would actually say.

## Body
- Be concise. The model is already capable: add only what it does not know. Challenge every
  paragraph: does it justify its cost in tokens?
- Keep SKILL.md under 500 lines. Move long detail into files under references/ and point to them
  from SKILL.md, one level deep ("See references/forms.md"). Give reference files longer than 100
  lines a table of contents.
- Match the degree of freedom to the task: plain guidance when many approaches work, a
  recommended pattern with parameters when some variation is fine, exact steps or a script when
  the operation is fragile or order-critical.
- Use numbered workflows and checklists for multi-step tasks, with a validation step (check the
  result, fix, repeat) for anything that can fail.
- Show input/output examples for formats and tone instead of describing them at length.
- Use one term per concept. Do not offer many options when one default will do.
- No time-sensitive information (dates, "before August"). Put legacy details in a clearly
  marked "old patterns" section if they are needed at all.
- Use forward slashes in every path, even for Windows.

## Extra files
- scripts/: executable helpers for deterministic work (parsing, converting, validating). Solve
  errors inside the script with clear messages instead of failing; no magic constants (explain
  every value); document dependencies and usage in the script header and in SKILL.md; say whether
  Claude should run the script or only read it. Prefer standard-library code.
- references/: documentation loaded on demand (API notes, schemas, long guides).
- assets/: templates, boilerplate and data the skill fills in or copies.
- Use descriptive file names ("merge_pdfs.py", "form-fields.md"), never "script1" or "doc2".
- Every file you include must be referenced from SKILL.md. Include a file only when it earns its
  place; a skill with only SKILL.md is often right.

## Safety
- Scripts are never run by the builder. Never include secrets, personal data or network calls the
  user did not ask for.`;

/** The reply contract appended after the authoring guidance. */
export const SKILL_DRAFT_INSTRUCTIONS = [
  "You write skills for Alisio, a desktop assistant that works on the user's own files.",
  "Follow the authoring guidance above and write in the language of the user's request.",
  "Reply with ONE JSON object and nothing else, using keys:",
  '"name" (the skill name), "description" (third person, ends with a "Use when ..." clause),',
  '"compatibility" (optional, only for real environment requirements such as a required program),',
  '"body" (the SKILL.md Markdown body WITHOUT frontmatter, under 500 lines) and',
  '"files" (an array of {"path", "content", "purpose"}; each path starts with scripts/,',
  "references/ or assets/, uses forward slashes and at most one subfolder; may be empty).",
  "Do not write YAML frontmatter yourself: it is generated from name and description.",
].join(" ");
