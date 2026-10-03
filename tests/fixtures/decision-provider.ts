import {
  type DecisionAnswer,
  type DecisionDefinition,
  type DecisionProvider,
  DecisionProviderError,
  type DecisionProviderErrorCode,
  type DecisionProviderResult,
  type DecisionRequest,
} from "@alisio/sdk";

export type FakeMode =
  | "ok"
  /** Waits `delayMs`, honoring the abort signal. */
  | "slow"
  /** Never settles and ignores the signal. */
  | "hang"
  /** Throws an untyped error. */
  | "throw"
  /** Throws a typed `DecisionProviderError` with `errorCode`. */
  | "typedError"
  /** Rejects with an AbortError of its own, without any caller abort. */
  | "providerAbort"
  /** Returns something that is not `{ decisions }`. */
  | "garbage"
  /** Answers every decision with confidence 0.1. */
  | "lowConfidence"
  /** Answers only the first requested decision. */
  | "partial"
  /** Answers every decision with an invalid answer. */
  | "invalidAnswers";

export interface FakeProviderOptions {
  id?: string;
  name?: string;
  mode?: FakeMode;
  capabilities?: Partial<DecisionProvider["capabilities"]>;
  delayMs?: number;
  errorCode?: DecisionProviderErrorCode;
  confidence?: number;
}

export interface FakeDecisionProvider extends DecisionProvider {
  mode: FakeMode;
  errorCode: DecisionProviderErrorCode;
  confidence: number;
  decideCalls: DecisionRequest[];
  healthCalls: number;
  signals: AbortSignal[];
  health: NonNullable<DecisionProvider["health"]>;
}

/** A valid answer for a definition: the first option / true / the first level. */
export function answerFor(definition: DecisionDefinition, confidence = 0.9): DecisionAnswer {
  switch (definition.type) {
    case "select":
      return { type: "select", value: Object.keys(definition.options)[0] as string, confidence };
    case "boolean":
      return { type: "boolean", value: true, confidence, probability: 0.9 };
    case "ordinal":
      return { type: "ordinal", level: definition.levels[0] as string, index: 0, confidence };
  }
}

/** In-memory `DecisionProvider` double; the mode can be changed between calls. */
export function fakeProvider(options: FakeProviderOptions = {}): FakeDecisionProvider {
  const provider: FakeDecisionProvider = {
    id: options.id ?? "fake",
    name: options.name ?? "Fake provider",
    capabilities: { select: true, boolean: true, ordinal: true, ...options.capabilities },
    mode: options.mode ?? "ok",
    errorCode: options.errorCode ?? "internal",
    confidence: options.confidence ?? 0.9,
    decideCalls: [],
    healthCalls: 0,
    signals: [],
    async health() {
      provider.healthCalls++;
      return { status: "ready" };
    },
    async decide(request, context): Promise<DecisionProviderResult> {
      provider.decideCalls.push(request);
      provider.signals.push(context.signal);
      const all = (confidence: number) =>
        Object.fromEntries(
          Object.entries(request.decisions).map(([key, def]) => [key, answerFor(def, confidence)]),
        );
      switch (provider.mode) {
        case "ok":
          return { decisions: all(provider.confidence), usage: { inputUnits: 3, outputUnits: 1 } };
        case "slow":
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, options.delayMs ?? 100);
            context.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(context.signal.reason);
              },
              { once: true },
            );
          });
          return { decisions: all(provider.confidence) };
        case "hang":
          return new Promise<DecisionProviderResult>(() => {});
        case "throw":
          throw new Error("provider exploded");
        case "typedError":
          throw new DecisionProviderError(provider.errorCode);
        case "providerAbort":
          throw new DOMException("provider gave up", "AbortError");
        case "garbage":
          return "nonsense" as unknown as DecisionProviderResult;
        case "lowConfidence":
          return { decisions: all(0.1) };
        case "partial": {
          const [first] = Object.entries(request.decisions);
          return { decisions: first ? { [first[0]]: answerFor(first[1]) } : {} };
        }
        case "invalidAnswers":
          return {
            decisions: Object.fromEntries(
              Object.keys(request.decisions).map((key) => [key, { type: "nope" }]),
            ) as unknown as DecisionProviderResult["decisions"],
          };
      }
    },
  };
  return provider;
}

/** A small valid request: one select, one boolean, one ordinal. */
export function sampleRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    version: 1,
    id: "test-site-v1",
    state: { goal: "monthly sales", columns: [{ role: "measure" }] },
    decisions: {
      kind: {
        type: "select",
        instruction: "Pick the chart kind",
        options: { bar: "Bars", line: "Line", pie: "Pie" },
      },
      stacked: { type: "boolean", instruction: "Stack the series?" },
      density: { type: "ordinal", instruction: "How dense?", levels: ["low", "medium", "high"] },
    },
    ...overrides,
  };
}
