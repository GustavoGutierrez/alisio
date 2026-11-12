/** Localized sentence for a classified creator failure (see `creatorFailure` in `model.ts`). */
import { type CreatorFailure, creatorFailure } from "./model.ts";
import { cr, issueText } from "./strings.ts";

export { creatorFailure };

export function failureMessage(failure: CreatorFailure): string {
  switch (failure.kind) {
    case "tests":
      return cr("buildFailedTests", {
        failed: failure.failed,
        total: failure.failed + failure.passed,
      });
    case "invalid":
      return [cr("buildFailedInvalid"), ...failure.issues.map((i) => issueText(i.code))].join(" ");
    case "busy":
      return cr("busy");
    case "readOnly":
      return cr("readOnly");
    case "model":
      return cr("modelMissing");
    case "notFound":
      return cr("notFound");
    case "notBuilt":
      return cr("notBuilt");
    default:
      return failure.message;
  }
}
