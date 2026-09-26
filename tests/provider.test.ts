import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
for (const mode of ["chat", "responses", "incomplete", "extensions"])
  it(`OpenAI-compatible ${mode} HTTP streaming contract`, async () => {
    const { stdout } = await execute(
      resolve("node_modules/bun/bin/bun.exe"),
      ["fixtures/provider-tests.ts", mode],
      { timeout: 10000 },
    );
    expect(JSON.parse(stdout)).toEqual({ mode, ok: true });
  });
