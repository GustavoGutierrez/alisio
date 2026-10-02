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
import type {
  ArtifactRef,
  AskQuestionsRequest,
  AskQuestionsResult,
  PlanReview,
  ToolResult,
} from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import { EXIT_PLAN_TOOL } from "../core/opt-in.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { objectSchema } from "../tools/standard.ts";
import {
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
}

const withArtifact = (result: ToolResult, artifact: ArtifactRef | undefined): ToolResult =>
  artifact
    ? {
        ...result,
        content: [...result.content, { type: "ui", block: { kind: "artifact", artifact } }],
      }
    : result;

const answer = (decision: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ decision, ...extra, message });

export function registerExitPlan(registry: ToolRegistry, deps: ExitPlanDeps): void {
  registry.register({
    name: EXIT_PLAN_TOOL,
    effect: "read",
    description:
      "Finish planning: hand the complete plan, in Markdown, to the user for review. Call it once, " +
      "when the plan is complete, instead of pasting the plan in your reply. The user can approve " +
      "(the build agent then implements exactly this plan), skip for now, or add context (the " +
      "result is `feedback`: revise the plan and call exit_plan again). Only the plan agent has " +
      "this tool. If review is unavailable (headless or read-only sessions) the result says so: " +
      "then give the complete plan as your final reply.",
    inputSchema: objectSchema(
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
    ),
    async execute(input, context) {
      const plan = String(input.plan ?? "").trim();
      if (!plan) throw new Error("exit_plan needs the whole plan in the `plan` field");
      const sessionId = context.session;
      const title = planTitle(plan, input.title);
      const hash = planHash(plan);
      const planId = crypto.randomUUID();
      const reviewable = !!sessionId && deps.ui.interactive() && !deps.readOnly;
      const revision = sessionId ? nextPlanRevision(deps.store, sessionId) : 1;

      // The plan is saved first, so the review (and every later turn) can point at it.
      let artifact: ArtifactRef | undefined;
      let publishNote = "";
      if (context.artifacts)
        try {
          artifact = await context.artifacts.publishText({
            fileName: "plan.md",
            title: revision > 1 ? `${title} (revision ${revision})` : title,
            text: `${plan}\n`,
          });
        } catch (error) {
          publishNote = ` The plan could not be saved as an artifact: ${error instanceof Error ? error.message : String(error)}.`;
        }
      const record = {
        planId,
        revision,
        hash,
        title,
        ...(context.callId ? { callId: context.callId } : {}),
        ...(artifact ? { artifactId: artifact.id } : {}),
      };

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
              artifact ? { artifactId: artifact.id } : {},
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
      const base = { planId, revision, ...(artifact ? { artifactId: artifact.id } : {}) };
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
                  "call exit_plan again with the complete updated plan.",
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
  });
}
