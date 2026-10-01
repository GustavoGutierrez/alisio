import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENGINE_INPUT_SHA256,
  ENGINE_SOURCE,
} from "../packages/core/src/analysis/data/engine-source.ts";
import { engineInputsHash } from "../scripts/analysis-data-engine-inputs.ts";

describe("embedded data engine", () => {
  it("was built from the current sources (regenerate with scripts/analysis-data-engine.ts)", () => {
    expect(ENGINE_INPUT_SHA256).toBe(engineInputsHash(resolve(".")));
  });

  it("is a self-contained ES module script that only imports Node built-ins", () => {
    const imports = [...ENGINE_SOURCE.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
    expect(ENGINE_SOURCE).not.toMatch(/from\s+["']\.{1,2}\//);
  });
});
