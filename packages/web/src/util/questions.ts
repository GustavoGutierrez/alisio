import type { PendingInteraction } from "@alisio/sdk";

/**
 * The answers a question panel starts with: like the terminal, a single-choice question begins on
 * its recommended option. Multi-select questions and requests that are not question lists start
 * empty, and nothing is submitted until the user confirms.
 */
export function initialAnswers(interaction: PendingInteraction): Record<string, string> {
  const initial: Record<string, string> = {};
  if (interaction.request.kind !== "questions") return initial;
  for (const q of interaction.request.questions) {
    const recommended = q.multiSelect ? undefined : q.options.find((o) => o.recommended);
    if (recommended) initial[q.id] = recommended.value;
  }
  return initial;
}
