/**
 * `exit_plan`: how the plan agent hands over its plan. The tool publishes the plan as a Markdown
 * artifact (`plan.md`, one revision per call), asks the user for a decision through the same
 * question infrastructure as `ask_user_question` and ALWAYS returns a tool result (approved,
 * skipped or feedback), so a session never keeps a dangling call. It does not switch agents or
 * start anything: an approved plan is recorded (`plan/state.ts`) and the host starts the
 * implementation turn once the plan run has ended.
 *
 * The tool is opt-in (`core/opt-in.ts`): only the plan agent's run lists it. Its effect is
 * `read`, so it is allowed under every policy; the plan agent stays read-only because its run
 * policy has no write/process/external effect, whatever the permission mode.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArtifactRef,
  AskQuestionsRequest,
  AskQuestionsResult,
  PlanDiagramInfo,
  PlanReview,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import type { CoreArtifactPublisher } from "../core/contracts.ts";
import { EXIT_PLAN_TOOL } from "../core/opt-in.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { objectSchema } from "../tools/standard.ts";
import {
  DIAGRAM_MAX_BYTES,
  DIAGRAM_MAX_NODES,
  type DroppedDiagram,
  type PlanDiagram,
  validateDiagrams,
} from "./diagrams.ts";
import { buildPlanManifest, type DiagramRecord } from "./manifest.ts";
import {
  currentPlan,
  decidePlan,
  nextPlanRevision,
  PLAN_CONTEXT_MAX_CHARS,
  PLAN_MAX_CHARS,
  PLAN_OPTIONS,
  PLAN_QUESTION_ID,
  PLAN_REVIEW_TITLE,
  PLAN_TEXT_KEY,
  type PlanDecision,
  type PlanStore,
  planHash,
  planTitle,
  proposePlan,
  withdrawPendingPlan,
} from "./state.ts";

export interface ExitPlanDeps {
  store: PlanStore;
  ui: {
    interactive(): boolean;
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
  };
  /** `--read-only`: nothing can be implemented afterwards, so there is no decision to take. */
  readOnly?: boolean;
  /** `plan.diagrams` and `plan.maxDiagrams`, read on every request (they change live). */
  diagrams?: () => { enabled: boolean; max: number };
}

const DIAGRAM_SCHEMA = {
  type: "array",
  description: `Optional Mermaid diagrams; see the plan agent's instructions`,
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "kebab-case, stable across revisions" },
      title: { type: "string" },
      explanation: { type: "string", description: "One short sentence" },
      section: { type: "string", description: "Plan heading it illustrates" },
      type: {
        type: "string",
        description: "overview, flow, components, architecture, sequence, data, state or other",
      },
      mermaid: { type: "string", description: "Mermaid source, no html, click or %%{init}" },
    },
  },
};

const BASE_DESCRIPTION =
  "Finish planning: hand the complete plan, in Markdown, to the user for review. Call it once, " +
  "when the plan is complete, instead of pasting the plan in your reply. The user can approve " +
  "(the build agent then implements exactly this plan), skip for now, or add context (the " +
  "result is `feedback`: revise the plan and call exit_plan again). Only the plan agent has " +
  "this tool. If review is unavailable (headless or read-only sessions) the result says so: " +
  "then give the complete plan as your final reply.";

const withArtifact = (result: ToolResult, artifact: ArtifactRef | undefined): ToolResult =>
  artifact
    ? {
        ...result,
        content: [...result.content, { type: "ui", block: { kind: "artifact", artifact } }],
      }
    : result;

const answer = (decision: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ decision, ...extra, message });

/** Everything one `exit_plan` call decided about its diagrams. */
interface DiagramOutcome {
  accepted: PlanDiagram[];
  dropped: DroppedDiagram[];
  removed: Array<{ id: string; title: string }>;
  /** True when the call or the previous revision involved diagrams (the result then reports them). */
  involved: boolean;
}

const diagramReport = (outcome: DiagramOutcome): Record<string, unknown> =>
  outcome.involved
    ? {
        diagrams: {
          accepted: outcome.accepted.map((d) => d.id),
          ...(outcome.dropped.length ? { dropped: outcome.dropped } : {}),
          ...(outcome.removed.length ? { removed: outcome.removed.map((d) => d.id) } : {}),
        },
      }
    : {};

/**
 * Writes the plan folder (`plan.md`, `plan.json`, `diagrams/<id>.mmd`) in a scratch directory the
 * publisher then copies, and removes the directory again.
 */
async function publishPlanFolder(
  publisher: CoreArtifactPublisher,
  files: Array<{ path: string; text: string }>,
  title: string,
): Promise<ArtifactRef> {
  const scratch = await mkdtemp(join(tmpdir(), "alisio-plan-"));
  try {
    const folder = join(scratch, "plan");
    for (const file of files) {
      const target = join(folder, ...file.path.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.text, { flag: "wx" });
    }
    const input = { source: folder, title, entry: "plan.md", fileName: "plan.md" };
    return typeof publisher.publishDetailed === "function"
      ? (await publisher.publishDetailed(input)).artifact
      : await publisher.publish(input);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function registerExitPlan(registry: ToolRegistry, deps: ExitPlanDeps): void {
  const settings = () => deps.diagrams?.() ?? { enabled: true, max: 5 };
  const offered = () => {
    const current = settings();
    return current.enabled && current.max > 0;
  };
  const plain = objectSchema(
    {
      title: { type: "string", maxLength: 120, description: "Short plan title" },
      plan: {
        type: "string",
        minLength: 1,
        maxLength: PLAN_MAX_CHARS,
        description: "The whole plan in Markdown",
      },
    },
    ["plan"],
  );
  const withDiagrams = objectSchema(
    { ...(plain.properties as Record<string, unknown>), diagrams: DIAGRAM_SCHEMA },
    ["plan"],
  );
  // The input is always VALIDATED with `diagrams` allowed (a call made while they were switched
  // off must not fail), but the model is only OFFERED the field while diagrams are on: the
  // registry compiles the schema once, while the provider reads it on every request.
  let registering = true;
  const tool: ToolDefinition = {
    name: EXIT_PLAN_TOOL,
    effect: "read",
    get description() {
      return offered()
        ? `${BASE_DESCRIPTION} Optional \`diagrams\`: up to ${settings().max} small Mermaid diagrams (see your instructions).`
        : BASE_DESCRIPTION;
    },
    get inputSchema() {
      return registering || offered() ? withDiagrams : plain;
    },
    async execute(input, context) {
      const plan = String(input.plan ?? "").trim();
      if (!plan) throw new Error("exit_plan needs the whole plan in the `plan` field");
      const sessionId = context.session;
      const title = planTitle(plan, input.title);
      const planId = crypto.randomUUID();
      const reviewable = !!sessionId && deps.ui.interactive() && !deps.readOnly;
      const revision = sessionId ? nextPlanRevision(deps.store, sessionId) : 1;
      const previous: DiagramRecord[] | undefined = sessionId
        ? currentPlan(deps.store, sessionId)?.diagrams
        : undefined;

      // Diagrams: validated without rendering; a bad one is dropped and the plan still goes out.
      const current = settings();
      const outcome: DiagramOutcome = { accepted: [], dropped: [], removed: [], involved: false };
      if (input.diagrams !== undefined) {
        outcome.involved = true;
        if (!current.enabled)
          outcome.dropped.push({
            id: "diagrams",
            reason: "diagrams are turned off (plan.diagrams); the plan was published without them",
          });
        else {
          const validated = validateDiagrams(input.diagrams, {
            max: current.max,
            maxBytes: DIAGRAM_MAX_BYTES,
            maxNodes: DIAGRAM_MAX_NODES,
          });
          outcome.accepted = validated.accepted;
          outcome.dropped = validated.dropped;
        }
      }
      const preManifest = buildPlanManifest({
        planId,
        revision,
        title,
        hash: "",
        markdown: plan,
        diagrams: outcome.accepted,
        ...(previous ? { previous } : {}),
      });
      outcome.removed = preManifest.removed;
      if (outcome.removed.length) outcome.involved = true;
      const hash = planHash(
        plan,
        preManifest.diagrams.map((d) => ({ id: d.id, hash: d.hash })),
      );
      const manifest = { ...preManifest, hash };
      const diagrams: PlanDiagramInfo[] = manifest.diagrams.map((entry, index) => ({
        id: entry.id,
        title: entry.title,
        explanation: entry.explanation,
        ...(entry.section ? { section: entry.section } : {}),
        type: entry.type,
        syntax: entry.syntax,
        status: entry.status,
        mermaid: outcome.accepted[index]?.mermaid ?? "",
      }));

      // The plan is saved first, so the review (and every later turn) can point at it.
      let artifact: ArtifactRef | undefined;
      let publishNote = "";
      const artifactTitle = revision > 1 ? `${title} (revision ${revision})` : title;
      const publisher = context.artifacts as CoreArtifactPublisher | undefined;
      if (publisher) {
        // A folder (plan.md + plan.json + diagrams) when diagrams are involved, else plan.md alone.
        if (outcome.accepted.length || outcome.removed.length)
          try {
            artifact = await publishPlanFolder(
              publisher,
              [
                { path: "plan.md", text: `${plan}\n` },
                { path: "plan.json", text: `${JSON.stringify(manifest, null, 2)}\n` },
                ...outcome.accepted.map((d) => ({
                  path: `diagrams/${d.id}.mmd`,
                  text: `${d.mermaid}\n`,
                })),
              ],
              artifactTitle,
            );
          } catch (error) {
            publishNote = ` The diagrams could not be saved with the plan: ${error instanceof Error ? error.message : String(error)}.`;
          }
        if (!artifact)
          try {
            artifact = await publisher.publishText({
              fileName: "plan.md",
              title: artifactTitle,
              text: `${plan}\n`,
            });
          } catch (error) {
            publishNote += ` The plan could not be saved as an artifact: ${error instanceof Error ? error.message : String(error)}.`;
          }
      }
      const record = {
        planId,
        revision,
        hash,
        title,
        ...(context.callId ? { callId: context.callId } : {}),
        ...(artifact ? { artifactId: artifact.id } : {}),
        ...(manifest.diagrams.length
          ? {
              diagrams: manifest.diagrams.map((d) => ({ id: d.id, title: d.title, hash: d.hash })),
            }
          : {}),
      };
      const report = diagramReport(outcome);

      if (!reviewable) {
        // Nobody to ask: keep the revision count honest and tell the model what to do instead.
        if (sessionId) proposePlan(deps.store, sessionId, { ...record, status: "skipped" });
        return withArtifact(
          textResult(
            answer(
              "unavailable",
              `No plan review is possible in this session (${
                deps.readOnly ? "it is read-only" : "it is not interactive"
              }), so nothing will be implemented from here. Give the complete plan in Markdown as your final reply and stop.${publishNote}`,
              { ...(artifact ? { artifactId: artifact.id } : {}), ...report },
            ),
          ),
          artifact,
        );
      }

      proposePlan(deps.store, sessionId, record);
      context.emitEvent?.("plan_proposed", {
        callId: context.callId ?? "",
        planId,
        revision,
        hash,
        title,
        ...(artifact ? { artifactId: artifact.id } : {}),
      });
      const review: PlanReview = {
        planId,
        revision,
        hash,
        title,
        markdown: plan,
        ...(artifact ? { artifact } : {}),
        ...(diagrams.length ? { diagrams } : {}),
      };
      const result = await deps.ui.askQuestions({
        questions: [
          {
            id: PLAN_QUESTION_ID,
            header: "Plan review",
            question: PLAN_REVIEW_TITLE,
            options: PLAN_OPTIONS,
          },
        ],
        plan: review,
        session: sessionId,
        ...(context.label ? { label: context.label } : {}),
        signal: context.signal,
      });

      const choice = result[PLAN_QUESTION_ID];
      const raw = result[PLAN_TEXT_KEY];
      const text = (typeof raw === "string" ? raw : "").trim().slice(0, PLAN_CONTEXT_MAX_CHARS);
      // Anything but a clear answer (Esc, closed screen, cancelled run, empty context) is a skip.
      const decision: PlanDecision =
        choice === "approve" ? "approve" : choice === "context" && text ? "context" : "skip";
      const decided = decidePlan(deps.store, sessionId, planId, decision, plan);
      if (!decided) {
        // Not pending any more (replaced or settled elsewhere): nothing to apply.
        withdrawPendingPlan(deps.store, sessionId);
        return withArtifact(
          textResult(
            answer("skipped", "This plan is no longer awaiting a decision. Stay in plan mode."),
          ),
          artifact,
        );
      }
      context.emitEvent?.("plan_decided", {
        callId: context.callId ?? "",
        planId,
        hash,
        decision,
      });
      const base = {
        planId,
        revision,
        ...(artifact ? { artifactId: artifact.id } : {}),
        ...report,
      };
      const body =
        decision === "approve"
          ? answer(
              "approved",
              "The user approved the plan. The build agent will implement exactly this plan in the " +
                "next turn. Do not implement anything yourself: reply with one short sentence and " +
                "call no more tools.",
              base,
            )
          : decision === "context"
            ? answer(
                "feedback",
                "The user added context instead of deciding. Revise the plan to account for it and " +
                  "call exit_plan again with the complete updated plan" +
                  (outcome.involved
                    ? ", with every diagram that still applies updated (and any dropped one fixed)."
                    : "."),
                { ...base, feedback: text },
              )
            : answer(
                "skipped",
                "The user chose to skip for now. Stay in plan mode and do not implement anything. " +
                  "Do not call exit_plan again unless the user asks; end your turn with one short sentence.",
                base,
              );
      return withArtifact(textResult(body), artifact);
    },
  };
  registry.register(tool);
  registering = false;
}
