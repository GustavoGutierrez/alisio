/** Command fingerprint v1 (specs/011 Fase 0 decision) and the credential redaction of excerpts. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redactOutput } from "../packages/core/src/eval/secrets.ts";
import {
  callFingerprint,
  commandFingerprint,
  criterionFingerprints,
  normalizeShell,
} from "../packages/core/src/proof/command.ts";

describe("command fingerprint v1", () => {
  it("is sha256 of the canonical JSON {v:1, argv, cwd}", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify({ v: 1, argv: ["pnpm", "test"], cwd: "." }))
      .digest("hex");
    expect(commandFingerprint(["pnpm", "test"], ".")).toBe(expected);
  });

  it("collapses whitespace outside quotes for shell and keeps quoted text verbatim", () => {
    expect(normalizeShell("  pnpm   test ")).toBe("pnpm test");
    expect(normalizeShell('echo "a  b"')).toBe('echo "a  b"');
    expect(callFingerprint("shell", { command: "pnpm   test" }, ".")).toBe(
      callFingerprint("shell", { command: "pnpm test" }, "."),
    );
    expect(callFingerprint("shell", { command: 'echo "a  b"' }, ".")).not.toBe(
      callFingerprint("shell", { command: 'echo "a b"' }, "."),
    );
  });

  it("normalizes the working directory", () => {
    const a = callFingerprint("run_process", { command: "pnpm", args: ["test"] }, "./pkg\\core");
    const b = callFingerprint("run_process", { command: "pnpm", args: ["test"] }, "pkg/core");
    expect(a).toBe(b);
  });

  it("a criterion command matches the run_process and the shell form of the same command", () => {
    const wanted = criterionFingerprints("pnpm test", ".");
    expect(wanted).toContain(
      callFingerprint("run_process", { command: "pnpm", args: ["test"] }, "."),
    );
    expect(wanted).toContain(callFingerprint("shell", { command: "pnpm  test" }, "."));
    expect(wanted).not.toContain(
      callFingerprint("run_process", { command: "pnpm", args: ["lint"] }, "."),
    );
  });

  it("quotes group arguments; shell operators only match the shell form", () => {
    expect(criterionFingerprints('node -e "a b"', ".")).toContain(
      callFingerprint("run_process", { command: "node", args: ["-e", "a b"] }, "."),
    );
    const piped = criterionFingerprints("pnpm test | tee out", ".");
    expect(piped).toHaveLength(1);
    expect(piped).toContain(callFingerprint("shell", { command: "pnpm test | tee out" }, "."));
  });
});

describe("redactOutput (excerpts)", () => {
  it("redacts generic password=/TOKEN= assignments and the known credential shapes", () => {
    const out = redactOutput(
      [
        "PASSWORD=hunter22",
        "db_password: s3cretvalue",
        'config {"api_token": "abcd1234"}',
        "TOKEN=abcd1234efgh",
        "OPENAI_API_KEY=zzzz1234",
        "Bearer abcdefghijklmnopqrstuvwxyz",
      ].join("\n"),
    );
    expect(out).not.toMatch(/hunter22|s3cretvalue|abcd1234|zzzz1234|abcdefghijkl/);
    expect(out.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("leaves ordinary text alone", () => {
    const text = "12 passed, 0 failed\nexpected token count to equal 3\nsecret sauce";
    expect(redactOutput(text)).toBe(text);
  });
});
