import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalReport, ProviderOAuthCredential } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import {
  type Cassette,
  CassetteWriteError,
  writeCassette,
} from "../packages/core/src/eval/cassette.ts";
import { buildExportBundle, EvalExportRefusedError } from "../packages/core/src/eval/export.ts";
import { buildReport, renderReportMarkdown } from "../packages/core/src/eval/report.ts";
import {
  knownSecretValues,
  OAuthManager,
  ProviderSettingsStore,
  redactCredentials,
  redactEventData,
  registerSecret,
  SecretRegistry,
} from "../packages/core/src/index.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { runsOf } from "./eval-helpers.ts";

// Not real tokens: shaped values for the tests.
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXZhbHVl";
const ACCESS = "opaque-access-value-0001";

describe("redactCredentials (OA-AC-15)", () => {
  it("redacts a JWT, a known exact value and a Bearer header, but not a short value", () => {
    const registry = new SecretRegistry();
    registry.add(ACCESS);
    registry.add("short"); // under 8 characters: never registered
    const text = `jwt=${JWT} exact=${ACCESS} short=short auth=Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345`;
    const out = redactCredentials(text, [], registry);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain(ACCESS);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("short=short");
    expect(out.match(/\[redacted\]/g)?.length).toBe(3);
  });

  it("takes extra exact values per call, and ignores those under 8 characters", () => {
    const registry = new SecretRegistry();
    expect(redactCredentials("a secret-value-x b", ["secret-value-x"], registry)).toBe(
      "a [redacted] b",
    );
    expect(redactCredentials("a tiny b", ["tiny"], registry)).toBe("a tiny b");
  });

  it("removes a value that contains another known value whole", () => {
    const registry = new SecretRegistry();
    registry.add("token-12345678");
    registry.add("token-12345678-and-more");
    expect(redactCredentials("x token-12345678-and-more y", [], registry)).toBe("x [redacted] y");
  });

  it("leaves ordinary text and short dotted words alone", () => {
    expect(redactCredentials("version 1.2.3 of eyJ.a.b is fine")).toBe(
      "version 1.2.3 of eyJ.a.b is fine",
    );
  });
});

describe("the registry and event data", () => {
  it("registers values from 8 characters on, in the process-wide set too", () => {
    const registry = new SecretRegistry();
    registry.add("12345678");
    registry.add("1234567");
    registry.add(undefined);
    expect(registry.values()).toEqual(["12345678"]);
    registerSecret("process-wide-secret-0001");
    expect(knownSecretValues()).toContain("process-wide-secret-0001");
  });

  it("redactEventData cleans only the error text, never mutates, and returns the same object when nothing changes", () => {
    registerSecret("event-secret-value-0001");
    const dirty = { error: "boom event-secret-value-0001", code: "x" };
    const cleaned = redactEventData(dirty);
    expect(cleaned).toEqual({ error: "boom [redacted]", code: "x" });
    expect(dirty.error).toContain("event-secret-value-0001");
    const clean = { error: "plain failure" };
    expect(redactEventData(clean)).toBe(clean);
    const noError = { text: "event-secret-value-0001" };
    expect(redactEventData(noError)).toBe(noError);
    expect(redactEventData("event-secret-value-0001")).toBe("event-secret-value-0001");
    expect(redactEventData(null)).toBeNull();
    expect(redactEventData(undefined)).toBeUndefined();
  });
});

describe("prompt values and rotated tokens (OA-AC-54)", () => {
  it("redacts a prompt value of 8+ characters, secret or not, and not a shorter one; rotated values stay", () => {
    const registry = new SecretRegistry();
    registry.add("paste-this-url-code"); // a `prompt` answer without secret: true
    registry.add("1234567"); // 7 characters
    for (const rotated of ["access-gen-1-aaaa", "access-gen-2-bbbb", "access-gen-3-cccc"])
      registry.add(rotated);
    const text =
      "code paste-this-url-code pin 1234567 / access-gen-1-aaaa access-gen-2-bbbb access-gen-3-cccc";
    const out = redactCredentials(text, [], registry);
    expect(out).toBe("code [redacted] pin 1234567 / [redacted] [redacted] [redacted]");
    expect(registry.values()).toHaveLength(4);
  });
});

describe("the manager feeds cassette and export scans (OA-AC-16, OA-AC-55)", () => {
  async function managerWithRotations() {
    const root = await mkdtemp(join(tmpdir(), "alisio-oauth-red-"));
    const store = new ProviderSettingsStore(root);
    const clock = { now: 1_800_000_000_000 };
    let n = 0;
    const secrets = new SecretRegistry();
    const manager = new OAuthManager({
      store,
      secrets,
      now: () => clock.now,
      registry: {
        get: () => ({
          auth: [
            {
              id: "browser",
              label: "b",
              kind: "oauth" as const,
              start: async () => ({ type: "oauth" as const, access: "x" }),
              refresh: async (): Promise<ProviderOAuthCredential> => ({
                type: "oauth",
                access: `access-rot-${++n}-0123456789`,
                refresh: `refresh-rot-${n}-0123456789`,
                expires: clock.now + 3_600_000,
              }),
            },
          ],
        }),
      },
    });
    await store.setOAuth(
      "p",
      {
        type: "oauth",
        access: "access-live-0123456789",
        refresh: "refresh-live-0123456789",
        expires: clock.now - 1,
      },
      { method: "browser", provider: "chatgpt" },
    );
    for (let i = 0; i < 3; i++) {
      await manager.get("p", "chatgpt");
      clock.now += 3_600_000; // next round: due again
    }
    return { manager, root };
  }

  const cassetteWith = (text: string): Cassette =>
    ({
      header: { version: 1, suiteId: "s", taskId: "t", configHash: "sha256:a", recordedAt: 1 },
      calls: [{ events: [{ type: "text_delta", delta: text }] }],
    }) as unknown as Cassette;

  it("hands live and rotated access and refresh values over as exact secrets", async () => {
    const { manager } = await managerWithRotations();
    const exact = await manager.exactSecrets();
    for (const value of [
      "access-rot-1-0123456789",
      "access-rot-2-0123456789",
      "refresh-rot-1-0123456789",
      "access-rot-3-0123456789",
      "refresh-rot-3-0123456789",
    ])
      expect(exact).toContain(value);
    // The very first, replaced value is still known: rotated values are kept for the process.
    expect(exact).toContain("access-live-0123456789");
    expect(exact).toContain("refresh-live-0123456789");
  });

  it("the store lists the stored sessions' values for scans made by a process that never renewed them", async () => {
    const { manager, root } = await managerWithRotations();
    await manager.exactSecrets();
    const stored = await new ProviderSettingsStore(root).oauthSecretValues();
    expect(stored).toEqual(["access-rot-3-0123456789", "refresh-rot-3-0123456789"]);
  });

  it("a cassette holding a known live or rotated value is refused, and nothing is written", async () => {
    const { manager } = await managerWithRotations();
    const secrets = await manager.exactSecrets();
    const dir = await mkdtemp(join(tmpdir(), "alisio-oauth-cass-"));
    for (const value of [
      "access-live-0123456789",
      "refresh-rot-2-0123456789",
      "access-rot-3-0123456789",
    ]) {
      const path = join(dir, "x.cassette.jsonl");
      let failure: unknown;
      try {
        writeCassette(path, cassetteWith(`the model saw ${value}`), { secrets });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CassetteWriteError);
      expect((failure as Error).message).not.toContain(value);
    }
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("an export holding a known value is refused; an unknown JWT adds no new refusal (RULES unchanged)", async () => {
    const { manager } = await managerWithRotations();
    const secrets = await manager.exactSecrets();
    const runs = runsOf("t1", ["pass"]);
    const report: EvalReport = buildReport(runs);
    const ctx = { roots: [], secrets };
    const withText = (text: string) => ({
      report,
      runs,
      markdown: `${renderReportMarkdown(report)}\n${text}`,
    });
    expect(() => buildExportBundle(withText("leak access-rot-2-0123456789"), ctx)).toThrow(
      EvalExportRefusedError,
    );
    // An unregistered JWT matches no rule of the eval table: still allowed, as before.
    expect(() => buildExportBundle(withText(`note ${JWT}`), ctx)).not.toThrow();
    const dir = await mkdtemp(join(tmpdir(), "alisio-oauth-cass2-"));
    expect(() =>
      writeCassette(join(dir, "y.cassette.jsonl"), cassetteWith(`note ${JWT}`), { secrets }),
    ).not.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("core exit points: run failures and the session journal (OA-AC-56)", () => {
  it("a provider error carrying a live token and a JWT leaves neither in the event nor in SQLite", async () => {
    const live = "live-token-for-redaction-0001";
    registerSecret(live);
    const root = await mkdtemp(join(tmpdir(), "alisio-oauth-run-"));
    const store = new SQLiteStore(join(root, "store.sqlite"));
    try {
      const session = store.create(root, "test", "test");
      const seen: unknown[] = [];
      const runner = new AgentRunner({
        provider: {
          id: "test",
          model: "test",
          async *stream() {
            throw new Error(`401 for ${live} and ${JWT}`);
          },
        } as never,
        registry: new ToolRegistry(),
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        onEvent: (event) => seen.push(event),
      });
      await expect(runner.run(session.id, "hi")).rejects.toThrow();
      const failed = (seen as Array<{ type: string; data: { error: string } }>).find(
        (event) => event.type === "run_failed",
      );
      expect(failed?.data.error).toContain("401 for [redacted] and [redacted]");
      const journal = JSON.stringify(store.eventsPage(session.id));
      const runs = JSON.stringify(store.runs(session.id));
      for (const stored of [JSON.stringify(seen), journal, runs]) {
        expect(stored).not.toContain(live);
        expect(stored).not.toContain(JWT);
      }
      expect(journal).toContain("[redacted]");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
