/**
 * Writes a reviewed skill draft to `<root>/<name>/`: SKILL.md plus its extra files, atomically
 * (a hidden temp folder next to the target, then a rename). Never executes anything and never
 * marks a file executable.
 */
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderSkillMd, type SkillDraft, validateSkillDraft } from "@alisio/sdk";
import { safePath } from "../runtime/paths.ts";

/** `invalid`: the draft breaks a hard rule; `exists`: the folder is taken and `overwrite` is off. */
export class SkillWriteError extends Error {
  constructor(
    readonly code: "invalid" | "exists",
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "SkillWriteError";
  }
}

export interface SkillWriteResult {
  dir: string;
  /** Paths relative to `dir`, SKILL.md first. */
  files: string[];
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function writeSkill(options: {
  root: string;
  draft: SkillDraft;
  overwrite?: boolean;
}): Promise<SkillWriteResult> {
  const { root, draft } = options;
  const { errors } = validateSkillDraft(draft);
  if (errors.length)
    throw new SkillWriteError(
      "invalid",
      `The skill is not valid: ${errors[0]?.message}`,
      errors.map((e) => e.message),
    );
  await mkdir(root, { recursive: true });
  const target = await safePath(root, draft.name);
  if ((await present(target)) && !options.overwrite)
    throw new SkillWriteError("exists", `A skill named ${draft.name} already exists here`);
  const temp = await mkdtemp(join(root, `.${draft.name}.tmp-`));
  let backup: string | undefined;
  try {
    const written: string[] = [];
    const put = async (relative: string, content: string) => {
      const path = await safePath(temp, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { encoding: "utf8", mode: 0o644 });
      await chmod(path, 0o644);
      written.push(relative);
    };
    await put("SKILL.md", renderSkillMd(draft));
    for (const file of draft.files) await put(file.path, file.content);
    await chmod(temp, 0o755);
    if (await present(target)) {
      backup = `${temp}.old`;
      await rename(target, backup);
    }
    try {
      await rename(temp, target);
    } catch (error) {
      if (backup) await rename(backup, target).catch(() => undefined);
      throw error;
    }
    if (backup) await rm(backup, { recursive: true, force: true });
    return { dir: target, files: written };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
