import { expect, it } from "vitest";
import { runMcpTest } from "../fixtures/mcp-test.ts";

for (const mode of ["stdio", "http"])
  it(`MCP ${mode}: tools, resources, prompts and cleanup (Node)`, async () => {
    expect(await runMcpTest(mode)).toEqual({ mode, ok: true });
  }, 20_000);
