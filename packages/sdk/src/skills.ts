/**
 * Skill Builder contract (open Agent Skills format): draft/save wire types plus the pure
 * validation and SKILL.md rendering shared by the server and the Web UI. Kept in its own
 * module so bundlers can leave it out of the Web UI initial chunk (only the lazily loaded
 * Skill Builder modal reaches it). Re-exported from `index.ts`.
 */

// ---- Skill Builder (open Agent Skills format) --------------------------------------------------
/** Which kind of extra files the skill builder may add; `auto` lets the model decide. */
export type SkillInclude = "auto" | "yes" | "no";
/** Where a skill written by the builder lives. */
export type SkillWriteScope = "project" | "global";
/** An extra text file of a skill: `scripts/`, `references/` or `assets/`, relative to its folder. */
export interface SkillDraftFile {
  path: string;
  content: string;
  /** One line on why the file exists (shown in the review step; never written to disk). */
  purpose?: string;
}
/**
 * A skill under review: open-standard frontmatter fields plus the Markdown body and extra files.
 * The frontmatter is always built from these fields, never taken from model-written YAML.
 * Consumers must ignore unknown fields.
 */
export interface SkillDraft {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** The SKILL.md body (Markdown, without frontmatter). */
  body: string;
  files: SkillDraftFile[];
  /** The model that wrote the draft. */
  generatedBy?: string;
  /** Authoring guidance used: `skill:<name>` or `bundled:skill-authoring`. */
  guidance?: string;
}
/** One validation finding: an error blocks saving, a warning is a suggestion. */
export interface SkillIssue {
  code: string;
  /** `name`, `description`, `compatibility`, `metadata`, `body`, `files` or `file`. */
  field: string;
  message: string;
  /** The file concerned, for `file` findings. */
  path?: string;
}
export interface SkillValidation {
  errors: SkillIssue[];
  warnings: SkillIssue[];
}
/** Body of `POST /api/workspaces/:wid/skills/draft`. */
export interface SkillDraftRequest {
  /** What the skill should do (required, up to 4000 characters). */
  idea: string;
  /** Example phrases or situations that should trigger the skill. */
  when?: string;
  include?: { scripts?: SkillInclude; templates?: SkillInclude; references?: SkillInclude };
  scope?: SkillWriteScope;
  /** The previous draft to refine together with `feedback`. */
  previous?: SkillDraft;
  feedback?: string;
}
/** Answer of `POST /api/workspaces/:wid/skills/draft`. */
export interface SkillDraftResult {
  draft: SkillDraft;
  /** Soft findings (suggestions) of the draft. */
  warnings: SkillIssue[];
  /** Hard findings the user must fix before saving; the model's draft may have some. */
  errors: SkillIssue[];
}
/** Body of `POST /api/workspaces/:wid/skills`. */
export interface SkillCreateRequest {
  scope: SkillWriteScope;
  draft: SkillDraft;
  /** Replace an existing folder of the same name (only after the user confirmed it). */
  overwrite?: boolean;
}
/** Answer of `POST /api/workspaces/:wid/skills`. */
export interface SkillCreateResult {
  skill: {
    name: string;
    scope: SkillWriteScope;
    /** Home-shortened or workspace-relative location of the skill folder. */
    path: string;
  };
  /** The running workspace already uses the new skill. */
  reloaded: boolean;
  /** Why it is not active yet (a run is active); reload from the UI later. */
  reason?: string;
}

/** Hard limits of a skill (the core parser refuses SKILL.md files above 64 000 bytes). */
export const SKILL_LIMITS = {
  name: 64,
  description: 1024,
  compatibility: 500,
  license: 200,
  metadataEntries: 20,
  metadataValue: 500,
  skillBytes: 64_000,
  files: 20,
  fileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
  bodyLinesAdvised: 500,
  bodyTokensAdvised: 5000,
  referenceLinesWithoutToc: 100,
} as const;
/** Top-level folders an extra file may live in. */
export const SKILL_FILE_ROOTS = ["scripts", "references", "assets"] as const;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VAGUE_NAME_WORDS = new Set([
  "helper",
  "helpers",
  "util",
  "utils",
  "tool",
  "tools",
  "document",
  "documents",
  "data",
  "file",
  "files",
  "stuff",
  "misc",
]);
const MONTHS =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Why `path` cannot be an extra file of a skill, or undefined when it is acceptable. */
export function skillFilePathProblem(path: string): string | undefined {
  if (typeof path !== "string" || !path) return "The path is empty";
  if (path.includes("\\")) return "Use forward slashes in file paths";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "File paths must be relative";
  const parts = path.split("/");
  if (parts.some((part) => part === "")) return "The path has an empty segment";
  if (parts.some((part) => part === "..")) return "File paths cannot contain `..`";
  if (parts.some((part) => part.startsWith("."))) return "Hidden files and folders are not allowed";
  if (!(SKILL_FILE_ROOTS as readonly string[]).includes(parts[0] ?? ""))
    return "Extra files live under scripts/, references/ or assets/";
  if (parts.length < 2) return "The path must name a file inside scripts/, references/ or assets/";
  if (parts.length > 3) return "Use at most one subfolder level";
  if (parts.some((part) => part.length > 100 || !/^[A-Za-z0-9._-]+$/.test(part)))
    return "File names may only use letters, digits, dots, hyphens and underscores";
  return undefined;
}

/** Local file paths a skill body points to (relative links and `scripts/…`-style mentions). */
function referencedPaths(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(
    /(?:^|[\s(`"'[])((?:scripts|references|assets)\/[A-Za-z0-9_./-]*[A-Za-z0-9_-])/g,
  ))
    if (match[1]) found.add(match[1]);
  for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = (match[1] ?? "").split(/[#?]/)[0] ?? "";
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
    found.add(target.replace(/^\.\//, ""));
  }
  return [...found];
}

/**
 * Validates a skill draft against the open Agent Skills format and Alisio's loader limits.
 * `errors` block saving; `warnings` are best-practice suggestions. `existingNames` (the skills
 * already discovered) enables the name-collision warning. Pure: shared by server and web.
 */
export function validateSkillDraft(
  draft: SkillDraft,
  options: { existingNames?: Iterable<string> } = {},
): SkillValidation {
  const errors: SkillIssue[] = [];
  const warnings: SkillIssue[] = [];
  const error = (code: string, field: string, message: string, path?: string) =>
    errors.push({ code, field, message, ...(path ? { path } : {}) });
  const warn = (code: string, field: string, message: string, path?: string) =>
    warnings.push({ code, field, message, ...(path ? { path } : {}) });
  const name = typeof draft.name === "string" ? draft.name : "";
  const description = typeof draft.description === "string" ? draft.description : "";
  const body = typeof draft.body === "string" ? draft.body : "";
  const files = Array.isArray(draft.files) ? draft.files : [];

  if (!name) error("name-required", "name", "The name is required");
  else {
    if (name.length > SKILL_LIMITS.name)
      error("name-length", "name", `The name is limited to ${SKILL_LIMITS.name} characters`);
    if (!SKILL_NAME.test(name))
      error(
        "name-format",
        "name",
        "Use lowercase letters, digits and single hyphens (for example pdf-merger)",
      );
    if (/anthropic|claude/.test(name.toLowerCase()))
      error("name-reserved", "name", 'The name cannot contain "anthropic" or "claude"');
    if (SKILL_NAME.test(name) && name.split("-").some((word) => VAGUE_NAME_WORDS.has(word)))
      warn(
        "name-vague",
        "name",
        "Prefer a specific name; words like helper, utils or data are vague",
      );
    const existing = new Set(options.existingNames ?? []);
    if (existing.has(name))
      warn(
        "name-collision",
        "name",
        "A skill with this name already exists; one of them will shadow the other",
      );
  }

  if (!description.trim())
    error("description-required", "description", "The description is required");
  else {
    if (description.length > SKILL_LIMITS.description)
      error(
        "description-length",
        "description",
        `The description is limited to ${SKILL_LIMITS.description} characters`,
      );
    if (/[<>]/.test(description))
      error("description-xml", "description", "The description cannot contain < or >");
    if (!/\b(?:use (?:when|this|it|for|if)|when)\b/i.test(description))
      warn(
        "description-when",
        "description",
        'Say when to use the skill, for example "Use when the user asks to …"',
      );
    if (
      /\b(?:you|your|you'?re|you'?ll)\b/i.test(description) ||
      /\b(?:I|I'm|I'll|my|me)\b/.test(description)
    )
      warn(
        "description-person",
        "description",
        "Write the description in the third person (it is injected into the system prompt)",
      );
  }

  if (draft.compatibility !== undefined) {
    if (typeof draft.compatibility !== "string" || !draft.compatibility.trim())
      error("compatibility-length", "compatibility", "Compatibility must be non-empty text");
    else if (draft.compatibility.length > SKILL_LIMITS.compatibility)
      error(
        "compatibility-length",
        "compatibility",
        `Compatibility is limited to ${SKILL_LIMITS.compatibility} characters`,
      );
  }
  if (
    draft.license !== undefined &&
    (typeof draft.license !== "string" || draft.license.length > SKILL_LIMITS.license)
  )
    error(
      "license-length",
      "license",
      `The license is limited to ${SKILL_LIMITS.license} characters`,
    );
  if (draft.metadata !== undefined) {
    const meta = draft.metadata as unknown;
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      error("metadata-type", "metadata", "Metadata must be a map of text to text");
    else {
      const entries = Object.entries(meta as Record<string, unknown>);
      if (entries.length > SKILL_LIMITS.metadataEntries)
        error(
          "metadata-type",
          "metadata",
          `Metadata is limited to ${SKILL_LIMITS.metadataEntries} entries`,
        );
      for (const [key, value] of entries)
        if (
          !/^[A-Za-z0-9_.-]{1,64}$/.test(key) ||
          typeof value !== "string" ||
          value.length > SKILL_LIMITS.metadataValue
        )
          error("metadata-type", "metadata", `Metadata entry "${key}" must be short text`);
    }
  }

  if (!body.trim()) error("body-required", "body", "The SKILL.md body is empty");
  else {
    const skillBytes = byteLength(renderSkillMd(draft));
    if (skillBytes > SKILL_LIMITS.skillBytes)
      error(
        "skill-size",
        "body",
        `SKILL.md is ${skillBytes} bytes; the limit is ${SKILL_LIMITS.skillBytes}. Move detail into references/`,
      );
    const lines = body.split("\n").length;
    if (lines > SKILL_LIMITS.bodyLinesAdvised || body.length / 4 > SKILL_LIMITS.bodyTokensAdvised)
      warn(
        "body-long",
        "body",
        `The body has ${lines} lines (about ${Math.round(body.length / 4)} tokens); keep it under ${SKILL_LIMITS.bodyLinesAdvised} lines and move detail into references/`,
      );
    if (
      new RegExp(
        `\\b(?:before|after|until|since|as of|in|by|during)\\s+(?:${MONTHS}\\s+)?(?:19|20)\\d{2}\\b`,
        "i",
      ).test(body)
    )
      warn("time-sensitive", "body", "Avoid time-sensitive wording such as dates; it goes stale");
    if (
      /\b(?:scripts|references|assets)\\[A-Za-z0-9_.-]+|\b[A-Za-z0-9_-]+\\[A-Za-z0-9_-]+\.[A-Za-z]{1,5}\b/.test(
        body,
      )
    )
      warn("backslash-path", "body", "Use forward slashes in file paths, even for Windows");
  }

  if (files.length > SKILL_LIMITS.files)
    error("files-count", "files", `At most ${SKILL_LIMITS.files} extra files are allowed`);
  const seen = new Set<string>();
  let total = byteLength(body);
  for (const file of files) {
    const path = typeof file?.path === "string" ? file.path : "";
    const content = typeof file?.content === "string" ? file.content : "";
    const problem = skillFilePathProblem(path);
    if (problem) {
      error("file-path", "file", problem, path || undefined);
      continue;
    }
    const key = path.toLowerCase();
    if (seen.has(key)) error("file-duplicate", "file", "Two files have the same path", path);
    seen.add(key);
    const size = byteLength(content);
    total += size;
    if (size > SKILL_LIMITS.fileBytes)
      error("file-size", "file", `Files are limited to ${SKILL_LIMITS.fileBytes / 1024} KB`, path);
    if (content.includes("\u0000"))
      error("file-binary", "file", "Only UTF-8 text files are allowed", path);
    if (path.startsWith("references/") && /\.(?:md|txt)$/.test(path)) {
      const lines = content.split("\n").length;
      if (
        lines > SKILL_LIMITS.referenceLinesWithoutToc &&
        !/^#{1,3}\s*(?:table of )?contents\b/im.test(content)
      )
        warn("reference-toc", "file", "Add a table of contents to long reference files", path);
    }
    if (path.startsWith("scripts/")) {
      const head = content.split("\n").slice(0, 40).join("\n");
      if (
        !/usage|dependenc|requires?|install|--help|argparse/i.test(head) &&
        !/usage|dependenc|requires?|pip install|npm (?:i|install)/i.test(body)
      )
        warn(
          "script-undocumented",
          "file",
          "Document the script's usage and dependencies (in the script header or SKILL.md)",
          path,
        );
    }
  }
  if (total > SKILL_LIMITS.totalBytes)
    error(
      "total-size",
      "files",
      `The skill is limited to ${SKILL_LIMITS.totalBytes / 1024 / 1024} MB in total`,
    );
  for (const reference of referencedPaths(body))
    if (!seen.has(reference.toLowerCase()))
      error(
        "reference-missing",
        "body",
        `The body points to ${reference}, which is not in the skill's files`,
        reference,
      );
  return { errors, warnings };
}

const yamlText = (value: string): string => JSON.stringify(value.replace(/\s*\n\s*/g, " ").trim());

/**
 * SKILL.md text: frontmatter built from the draft's fields (JSON-quoted scalars are valid YAML,
 * so model text can never inject keys), a blank line, then the body.
 */
export function renderSkillMd(draft: SkillDraft): string {
  const lines = ["---", `name: ${draft.name}`, `description: ${yamlText(draft.description ?? "")}`];
  if (draft.license) lines.push(`license: ${yamlText(draft.license)}`);
  if (draft.compatibility) lines.push(`compatibility: ${yamlText(draft.compatibility)}`);
  const metadata = Object.entries(draft.metadata ?? {});
  if (metadata.length) {
    lines.push("metadata:");
    for (const [key, value] of metadata)
      lines.push(`  ${JSON.stringify(key)}: ${yamlText(String(value))}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${(draft.body ?? "").trim()}\n`;
}
