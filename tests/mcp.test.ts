import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
for (const mode of ["stdio", "http"])
  it(`MCP ${mode}: tools, resources, prompts and cleanup`, async () => {
    const { stdout } = await execute(
      resolve("node_modules/bun/bin/bun.exe"),
      ["fixtures/mcp-test.ts", mode],
      { timeout: 15000 },
    );
    expect(JSON.parse(stdout)).toEqual({ mode, ok: true });
  }, 20000);
