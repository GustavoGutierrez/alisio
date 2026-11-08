/**
 * Skill Builder API: the active model drafts a skill in the open Agent Skills format
 * (`POST /api/workspaces/:wid/skills/draft`, cancelled when the client closes the request) and a
 * reviewed draft is validated and written atomically (`POST /api/workspaces/:wid/skills`) to
 * `<workspace>/.agents/skills` (trusted workspaces only) or `~/.agents/skills`. The workspace is
 * then reloaded so the skill is active without restarting; while a run is active it is reported
 * as not live yet. Scripts are written as plain files and never executed.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateSkillDraft,
  SKILL_FEEDBACK_MAX,
  SKILL_IDEA_MAX,
  SkillWriteError,
  skillAuthoringGuidance,
  writeSkill,
} from "@alisio/core";
import {
  type SkillCreateResult,
  type SkillDraft,
  type SkillDraftRequest,
  type SkillDraftResult,
  type SkillWriteScope,
  validateSkillDraft,
} from "@alisio/sdk";
import type { OpenWorkspace } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";
import { type ManagementContext, type WorkspaceRecycler, workspaceApp } from "./management.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const INCLUDE = ["auto", "yes", "no"] as const;
const SCOPES: SkillWriteScope[] = ["project", "global"];

/** Structural check of a draft coming from the client; semantic rules live in `validateSkillDraft`. */
const isDraft = (value: unknown): boolean => {
  if (!is.object()(value)) return false;
  const draft = value as Record<string, unknown>;
  const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  const optional = (v: unknown, max: number) => v === undefined || text(v, max);
  return (
    text(draft.name, 200) &&
    text(draft.description, 5_000) &&
    text(draft.body, 300_000) &&
    optional(draft.license, 1_000) &&
    optional(draft.compatibility, 5_000) &&
    optional(draft.generatedBy, 200) &&
    optional(draft.guidance, 200) &&
    (draft.metadata === undefined || is.object()(draft.metadata)) &&
    Array.isArray(draft.files) &&
    draft.files.length <= 100 &&
    draft.files.every(
      (file) =>
        is.object()(file) &&
        typeof (file as Record<string, unknown>).path === "string" &&
        typeof (file as Record<string, unknown>).content === "string" &&
        ((file as Record<string, unknown>).content as string).length <= 600_000 &&
        ((file as Record<string, unknown>).path as string).length <= 300,
    )
  );
};

export function registerSkillBuilderRoutes(
  router: Router,
  ctx: ManagementContext,
  recycler: WorkspaceRecycler,
): void {
  const existingNames = (opened: OpenWorkspace) =>
    opened.app
      .skillCatalog()
      .filter((skill) => skill.effective)
      .map((skill) => skill.name);

  router.post("/api/workspaces/:wid/skills/draft", async ({ req, res, params }) => {
    const input = validate<SkillDraftRequest>(await readJson(req), {
      idea: { check: is.nonEmpty(SKILL_IDEA_MAX), required: true },
      when: { check: is.string(2_000) },
      include: {
        check: (v) =>
          is.object()(v) &&
          Object.entries(v as Record<string, unknown>).every(
            ([key, value]) =>
              ["scripts", "templates", "references"].includes(key) &&
              INCLUDE.includes(value as (typeof INCLUDE)[number]),
          ),
      },
      scope: { check: is.oneOf(SCOPES) },
      previous: { check: isDraft },
      feedback: { check: is.string(SKILL_FEEDBACK_MAX) },
    });
    const opened = await workspaceApp(ctx.workspaces, params.wid);
    // The client's Cancel closes the request: abort the model call with it.
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort(new Error("Cancelled"));
    });
    let draft: SkillDraft;
    try {
      draft = await generateSkillDraft(opened.app.provider, input, {
        signal: controller.signal,
        guidance: await skillAuthoringGuidance(opened.app.skills),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError("cancelled", "The draft was cancelled");
      throw new HttpError("provider_unavailable", `Draft failed: ${message(error)}`);
    }
    const { errors, warnings } = validateSkillDraft(draft, {
      existingNames: existingNames(opened),
    });
    const body: SkillDraftResult = { draft, warnings, errors };
    return { body };
  });

  router.post("/api/workspaces/:wid/skills", async ({ req, params }) => {
    if (ctx.base.readOnly)
      throw new HttpError("capability_ceiling", "Skill changes are unavailable under --read-only");
    const input = validate<{ scope: SkillWriteScope; draft: SkillDraft; overwrite?: boolean }>(
      await readJson(req),
      {
        scope: { check: is.oneOf(SCOPES), required: true },
        draft: { check: isDraft, required: true },
        overwrite: { check: is.boolean() },
      },
    );
    const opened = await workspaceApp(ctx.workspaces, params.wid);
    if (input.scope === "project" && !opened.trusted)
      throw new HttpError(
        "not_manageable",
        "Trust this workspace to save project skills, or save the skill globally",
      );
    const root =
      input.scope === "project"
        ? join(opened.path, ".agents", "skills")
        : join(homedir(), ".agents", "skills");
    try {
      await writeSkill({
        root,
        draft: input.draft,
        ...(input.overwrite ? { overwrite: true } : {}),
      });
    } catch (error) {
      if (error instanceof SkillWriteError) {
        if (error.code === "exists")
          throw new HttpError("skill_exists", `A skill named ${input.draft.name} already exists`, {
            fields: ["name"],
          });
        throw new HttpError("validation_failed", error.message, { fields: ["draft"] });
      }
      throw error;
    }
    // Reload so the skill is active now; a run in progress defers it (the UI says so).
    let reloaded = false;
    let reason: string | undefined;
    try {
      await recycler.reload(opened.id);
      reloaded = true;
    } catch (error) {
      reason =
        error instanceof HttpError
          ? error.message
          : "The workspace could not be reloaded; reload it from Settings";
    }
    recycler.announce(opened.id, ["skills", "commands"]);
    const body: SkillCreateResult = {
      skill: {
        name: input.draft.name,
        scope: input.scope,
        path:
          input.scope === "project"
            ? `.agents/skills/${input.draft.name}`
            : `~/.agents/skills/${input.draft.name}`,
      },
      reloaded,
      ...(reason ? { reason } : {}),
    };
    return { status: 201, body };
  });
}
