import type { PendingInteraction } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { initialAnswers } from "../packages/web/src/util/questions.ts";

const questions = (list: unknown[]) =>
  ({
    interactionId: "i1",
    request: { kind: "questions", questions: list },
  }) as unknown as PendingInteraction;

describe("initialAnswers", () => {
  it("starts a single-choice question on its recommended option", () => {
    const result = initialAnswers(
      questions([
        {
          id: "q1",
          multiSelect: false,
          options: [{ value: "no" }, { value: "yes", recommended: true }],
        },
      ]),
    );
    expect(result).toEqual({ q1: "yes" });
  });

  it("leaves a question without a recommended option unanswered", () => {
    const result = initialAnswers(
      questions([{ id: "q1", multiSelect: false, options: [{ value: "a" }, { value: "b" }] }]),
    );
    expect(result).toEqual({});
  });

  it("never pre-selects in a multi-select question", () => {
    const result = initialAnswers(
      questions([
        {
          id: "q1",
          multiSelect: true,
          options: [{ value: "a", recommended: true }, { value: "b" }],
        },
      ]),
    );
    expect(result).toEqual({});
  });

  it("ignores requests that are not question lists", () => {
    const select = { interactionId: "i2", request: { kind: "select", options: [] } };
    expect(initialAnswers(select as unknown as PendingInteraction)).toEqual({});
  });
});
