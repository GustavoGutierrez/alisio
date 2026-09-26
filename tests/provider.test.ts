import { expect, it } from "vitest";
import { runProviderTest } from "../fixtures/provider-tests.ts";

for (const mode of ["chat", "responses", "incomplete", "extensions"])
  it(`OpenAI-compatible ${mode} HTTP streaming contract (Node)`, async () => {
    expect(await runProviderTest(mode)).toEqual({ mode, ok: true });
  });
