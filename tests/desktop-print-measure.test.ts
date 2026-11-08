import { describe, expect, it } from "vitest";
import { MEASURE_SCRIPT as desktop } from "../apps/desktop/src/print-measure.ts";
import { MEASURE_SCRIPT as core } from "../packages/core/src/documents/engines/chromium/adapter.ts";

describe("desktop print measurement script", () => {
  it("is identical to the one the Chromium adapter runs", () => {
    expect(desktop).toBe(core);
  });
});
