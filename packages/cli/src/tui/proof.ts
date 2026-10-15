/**
 * `/proof` in the terminal (specs/011 phase 5). It reads the same ledger as the web card and the
 * `--json` event (`renderProofText` is the one formatter) and carries the user's own actions: add,
 * edit, mark required, mark not applicable (with a reason), export. Criteria are addressed by
 * their position in the list shown. Everything here is the USER acting; a tool result or the model
 * never reaches this module.
 */
import {
  type ProofStore,
  parseCriteriaInput,
  publishProofExport,
  renderProofText,
} from "@alisio/core";
import type { ArtifactPublisher } from "@alisio/sdk";

export const PROOF_USAGE =
  "Usage: /proof | add [required] <text> [-- <command>] | edit <n> <text> | required <n> | optional <n> | na <n> <reason> | export | help";

export const PROOF_HELP = [
  "**/proof** shows the acceptance criteria of this session and the evidence behind each one.",
  "",
  "- `/proof` lists them: `verified` needs evidence of a command that really ran; `not_checked` has none yet.",
  "- `/proof add [required] <text> [-- <command>]` adds a criterion; with a command it is verified when the agent runs exactly that command and it succeeds.",
  "- `/proof edit <n> <text>`, `/proof required <n>`, `/proof optional <n>` change the criterion at that position.",
  "- `/proof na <n> <reason>` marks it not applicable (only you can; the reason is kept).",
  "- `/proof export` publishes `proof.md` and `proof.json` (`proof/v1`) as session artifacts.",
  "",
  "Proof records operational evidence; it does not prove that the code is correct.",
].join("\n");

export type ProofCommand =
  | { type: "show" }
  | { type: "help" }
  | { type: "add"; text: string; command?: string; required: boolean }
  | { type: "edit"; index: number; text: string }
  | { type: "required"; index: number; required: boolean }
  | { type: "na"; index: number; reason: string }
  | { type: "export" }
  | { type: "error"; message: string };

const bad = (message: string): ProofCommand => ({ type: "error", message });
const position = (word: string | undefined): number | undefined =>
  word && /^[1-9]\d*$/.test(word) ? Number(word) : undefined;

export function parseProofCommand(args: string): ProofCommand {
  const text = args.trim();
  if (!text) return { type: "show" };
  const [verb = "", ...rest] = text.split(/\s+/);
  const tail = (skip: number) => text.split(/\s+/).slice(skip).join(" ").trim();
  switch (verb.toLowerCase()) {
    case "help":
      return { type: "help" };
    case "export":
      return { type: "export" };
    case "add": {
      let body = tail(1);
      let required = false;
      if (/^required(\s|$)/i.test(body)) {
        required = true;
        body = body.replace(/^required\s*/i, "");
      }
      const split = body.split(/\s+--\s+/);
      const statement = (split[0] ?? "").trim();
      const command = split.slice(1).join(" -- ").trim();
      if (!statement) return bad("/proof add needs the criterion text.");
      return { type: "add", text: statement, ...(command ? { command } : {}), required };
    }
    case "edit": {
      const index = position(rest[0]);
      const wording = tail(2);
      if (index === undefined || !wording) return bad("/proof edit needs a position and the text.");
      return { type: "edit", index, text: wording };
    }
    case "required":
    case "optional": {
      const index = position(rest[0]);
      if (index === undefined) return bad(`/proof ${verb} needs a position.`);
      return { type: "required", index, required: verb.toLowerCase() === "required" };
    }
    case "na": {
      const index = position(rest[0]);
      const reason = tail(2);
      if (index === undefined || !reason) return bad("/proof na needs a position and a reason.");
      return { type: "na", index, reason };
    }
    default:
      return bad(`Unknown /proof verb "${verb}".`);
  }
}

export interface ProofCommandEnv {
  proof: ProofStore;
  sessionId: string;
  /** Publishes the export; absent when the session cannot publish artifacts. */
  publisher?: Pick<ArtifactPublisher, "publishText">;
}

export interface ProofCommandResult {
  text: string;
  tone: "info" | "notice";
}

/** Runs a typed `/proof …`; every failure is a notice, never an exception. */
export async function runProofCommand(
  args: string,
  env: ProofCommandEnv,
): Promise<ProofCommandResult> {
  const command = parseProofCommand(args);
  const notice = (text: string): ProofCommandResult => ({ text, tone: "notice" });
  const show = (): ProofCommandResult => ({
    text: renderProofText(env.proof.view(env.sessionId)),
    tone: "info",
  });
  try {
    switch (command.type) {
      case "error":
        return notice(`${command.message}\n${PROOF_USAGE}`);
      case "help":
        return { text: PROOF_HELP, tone: "info" };
      case "show":
        return show();
      case "export": {
        if (!env.publisher) return notice("This session cannot publish artifacts.");
        await publishProofExport(env.publisher, env.proof.view(env.sessionId));
        return notice("Published proof.md and proof.json (proof/v1) as session artifacts.");
      }
      case "add": {
        const parsed = parseCriteriaInput(
          [
            {
              text: command.text,
              required: command.required,
              ...(command.command ? { verify: command.command } : {}),
            },
          ],
          { origin: "user", defaultRequired: false },
        );
        const criterion = parsed.criteria[0];
        if (!criterion) return notice(parsed.errors[0]?.reason ?? "Invalid criterion.");
        env.proof.addCriterion({ sessionId: env.sessionId, ...criterion });
        return show();
      }
      default: {
        const target = env.proof.criteria(env.sessionId)[command.index - 1];
        if (!target) return notice(`There is no criterion ${command.index}.`);
        if (command.type === "na") env.proof.markNotApplicable(target.criterionId, command.reason);
        else
          env.proof.updateCriterion(target.criterionId, {
            ...(command.type === "edit" ? { text: command.text } : { required: command.required }),
          });
        return show();
      }
    }
  } catch (error) {
    return notice(error instanceof Error ? error.message : String(error));
  }
}
