/**
 * Proof phase 6 (specs/011 3.8, O7, D2, D6): `api.proof?.registerVerifier`. A plugin verifier must
 * return referenceable evidence; without it the criterion degrades to `manual_review`. Plugins
 * gain no permission (their calls go through the core tools and its gate), and a core without
 * `api.proof` must not break a plugin that uses it optionally.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  definePlugin,
  type Plugin,
  type PluginAPI,
  type ProofResult,
  type ProofVerifierContext,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginHost,
  ProofRecorder,
  ProofStore,
  ProofVerifierRegistry,
  ProviderRegistry,
  ToolRegistry,
  verifyCriterion,
} from "../packages/core/src/index.ts";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { Skills } from "../packages/core/src/resources/skills.ts";
import { registerStandard } from "../packages/core/src/tools/standard.ts";
import { gateFixture } from "./forge-gate-helpers.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const state = () => ({ getState: () => undefined, setState: () => {} });
const plugin = (id: string, setup: Plugin["setup"]): Plugin =>
  definePlugin({ id, version: "1.0.0", apiVersion: 1, setup });
const newHost = () => new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());

describe("api.proof on the plugin host", () => {
  it("is absent on a host without Proof, and an optional user keeps working (an older core)", async () => {
    const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    let seen: PluginAPI["proof"] = { registerVerifier: () => () => {} };
    let toolRegistered = false;
    await host.activate(
      plugin("opt.user", (api) => {
        seen = api.proof;
        const unregister = api.proof?.registerVerifier({
          id: "v",
          describe: "d",
          run: async () => ({ ok: true, outputHash: hash("x") }),
        });
        unregister?.();
        api.tools.register({
          name: "still_here",
          description: "d",
          effect: "read",
          inputSchema: { type: "object", properties: {} },
          async execute() {
            return { content: [{ type: "text", text: "ok" }] };
          },
        });
        toolRegistered = true;
      }),
      ".",
    );
    expect(seen).toBeUndefined();
    expect(toolRegistered).toBe(true);
  });

  it("registers a verifier under the plugin id and removes it on unregister and on dispose", async () => {
    const host = newHost();
    const registry = new ProofVerifierRegistry();
    host.setProofVerifiers(registry);
    let unregister: (() => void) | undefined;
    await host.activate(
      plugin("acme.checks", (api) => {
        unregister = api.proof?.registerVerifier({
          id: "links",
          describe: "Checks links",
          run: async () => ({ ok: true, outputHash: hash("x") }),
        });
      }),
      ".",
    );
    expect(registry.list()).toEqual([
      { verifierId: "acme.checks:links", plugin: "acme.checks", describe: "Checks links" },
    ]);
    unregister?.();
    expect(registry.list()).toEqual([]);
  });

  it("rejects an invalid or duplicate id and a verifier without run, and rolls the plugin back", async () => {
    const host = newHost();
    host.setProofVerifiers(new ProofVerifierRegistry());
    let n = 0;
    const bad = (id: string, run: unknown = async () => ({ ok: true, outputHash: hash("x") })) =>
      host.activate(
        plugin(`bad.${++n}`, (api) => {
          api.proof?.registerVerifier({ id, describe: "d", run } as never);
        }),
        ".",
      );
    await expect(bad("Has Space")).rejects.toThrow(/Invalid verifier id/);
    await expect(bad("")).rejects.toThrow(/Invalid verifier id/);
    await expect(bad("ok", null)).rejects.toThrow(/run/);
    await expect(
      host.activate(
        plugin("dup", (api) => {
          const v = {
            id: "a",
            describe: "d",
            run: async () => ({ ok: true, outputHash: hash("x") }),
          };
          api.proof?.registerVerifier(v);
          api.proof?.registerVerifier(v);
        }),
        ".",
      ),
    ).rejects.toThrow(/Duplicate verifier/);
  });
});

async function open(policy: "full" | "readonly" = "full") {
  const readonly = policy === "readonly";
  const fx = await gateFixture({
    policy: readonly
      ? { write: false, process: false, external: false }
      : { ...PERMISSION_MODE_TABLE.full.policy },
    ...(readonly ? { approve: false as const } : {}),
    proof: (store) => new ProofRecorder(store.db),
  });
  closers.push(() => fx.close());
  registerStandard(fx.registry, fx.root, new Skills(), new ProjectContext(fx.root));
  const proof = new ProofStore(fx.store.db);
  const registry = new ProofVerifierRegistry();
  const host = newHost();
  host.setProofVerifiers(registry);
  const deps = {
    store: proof,
    registry,
    db: fx.store.db,
    callTool: (
      sessionId: string,
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => fx.runner.runToolCall(sessionId, name, input, { signal }),
    timeoutMs: 10_000 as number,
  };
  /** Registers `run` as `acme:v` through the real plugin host and binds a criterion to it. */
  const withVerifier = async (
    run: (input: unknown, ctx: ProofVerifierContext) => Promise<ProofResult>,
    input?: unknown,
  ) => {
    await host.activate(
      plugin("acme", (api) => {
        api.proof?.registerVerifier({ id: "v", describe: "d", run: run as never });
      }),
      ".",
    );
    return proof.addCriterion({
      sessionId: fx.session,
      text: "plugin check",
      origin: "user",
      required: true,
      verifier: { kind: "plugin", verifierId: "acme:v", ...(input !== undefined ? { input } : {}) },
    });
  };
  const verify = (criterionId: string) =>
    verifyCriterion(deps as never, { sessionId: fx.session, criterionId, workspace: fx.root });
  const state_ = (criterionId: string) => {
    const ledger = proof.ledger(fx.session);
    return {
      status: ledger.criteria.find((c) => c.criterionId === criterionId)?.status,
      evidence: ledger.evidence.filter((e) => e.criterionId === criterionId),
    };
  };
  return { fx, proof, registry, host, deps, withVerifier, verify, state: state_ };
}

describe("a plugin verifier runs and its evidence is checked", () => {
  it("verified with an outputHash: evidence carries the verifier kind, the hash and a verification id", async () => {
    const t = await open();
    const seen: unknown[] = [];
    const c = await t.withVerifier(
      async (input) => {
        seen.push(input);
        return { ok: true, outputHash: hash("links ok"), excerpt: "12 links ok" };
      },
      { site: "docs" },
    );
    const outcome = await t.verify(c.criterionId);
    expect(outcome.status).toBe("verified");
    const { evidence } = t.state(c.criterionId);
    expect(seen).toEqual([{ site: "docs" }]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      verifierKind: "plugin",
      ok: true,
      outputHash: hash("links ok"),
      excerpt: "12 links ok",
    });
    expect(evidence[0]?.runId).toBeTruthy();
    expect(evidence[0]?.callId).toBeTruthy();
  });

  it("a failing verdict with evidence is failed", async () => {
    const t = await open();
    const c = await t.withVerifier(async () => ({ ok: false, outputHash: hash("2 broken") }));
    expect((await t.verify(c.criterionId)).status).toBe("failed");
    expect(t.state(c.criterionId).evidence[0]?.ok).toBe(false);
  });

  it.each([
    ["no outputHash", { ok: true }],
    ["a malformed outputHash", { ok: true, outputHash: "abc" }],
    ["an empty result", {}],
    ["not an object", "verified"],
    ["a non-boolean verdict", { ok: "yes", outputHash: hash("x") }],
  ])("%s degrades to manual_review", async (_label, result) => {
    const t = await open();
    const c = await t.withVerifier(async () => result as never);
    const outcome = await t.verify(c.criterionId);
    expect(outcome.status).toBe("manual_review");
    expect(outcome.reason).toBe("no_referenceable_evidence");
    // the degradation itself is journaled as evidence of kind manual, never as a pass
    expect(t.state(c.criterionId).evidence.map((e) => [e.verifierKind, e.ok])).toEqual([
      ["manual", false],
    ]);
  });

  it("a callId the session never made is not evidence either", async () => {
    const t = await open();
    const c = await t.withVerifier(async () => ({
      ok: true,
      outputHash: hash("x"),
      callId: "forged-1",
    }));
    expect((await t.verify(c.criterionId)).status).toBe("manual_review");
  });

  it("a callId from the verifier's own core tool call is accepted and linked to that call and run", async () => {
    const t = await open();
    await mkdir(join(t.fx.root, "docs"), { recursive: true });
    await writeFile(join(t.fx.root, "docs/a.md"), "hello");
    const c = await t.withVerifier(async (_input, ctx) => {
      const { callId, result } = await ctx.callTool("read_file", { path: "docs/a.md" });
      const text = result.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      return { ok: text.includes("hello"), outputHash: hash(text), callId };
    });
    expect((await t.verify(c.criterionId)).status).toBe("verified");
    const evidence = t.state(c.criterionId).evidence[0];
    const row = t.fx.store.db
      .prepare("SELECT run_id,name FROM tool_calls WHERE session=? AND call_id=?")
      .get(t.fx.session, evidence?.callId ?? "");
    expect(row?.name).toBe("read_file");
    expect(String(row?.run_id)).toBe(evidence?.runId);
  });

  it("a verifier that throws or hangs leaves the criterion not_checked with a reason, and no evidence", async () => {
    const t = await open();
    const boom = await t.withVerifier(async () => {
      throw new Error("kaput token=abc123456789");
    });
    const outcome = await t.verify(boom.criterionId);
    expect(outcome).toMatchObject({ status: "not_checked", reason: "verifier_failed" });
    expect(JSON.stringify(outcome)).not.toContain("abc123456789");
    expect(t.state(boom.criterionId).evidence).toEqual([]);
  });

  it("times out a verifier that never answers", async () => {
    const t = await open();
    t.deps.timeoutMs = 100;
    const c = await t.withVerifier(
      (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const outcome = await t.verify(c.criterionId);
    expect(outcome).toMatchObject({ status: "not_checked", reason: "verifier_failed" });
  });

  it("a criterion bound to a verifier that is not registered stays not_checked", async () => {
    const t = await open();
    const c = t.proof.addCriterion({
      sessionId: t.fx.session,
      text: "x",
      origin: "user",
      required: true,
      verifier: { kind: "plugin", verifierId: "gone:v" },
    });
    expect(await t.verify(c.criterionId)).toMatchObject({
      status: "not_checked",
      reason: "verifier_unavailable",
    });
  });

  it("a later verification replaces the verdict: the latest evidence decides", async () => {
    const t = await open();
    let ok = false;
    const c = await t.withVerifier(async () => ({ ok, outputHash: hash(String(ok)) }));
    expect((await t.verify(c.criterionId)).status).toBe("failed");
    ok = true;
    expect((await t.verify(c.criterionId)).status).toBe("verified");
    expect(t.state(c.criterionId).evidence).toHaveLength(2);
  });
});

describe("a plugin verifier gains no permission (D6)", () => {
  it("its tool calls pass the core gate: a process call is refused in read-only mode and never runs", async () => {
    const t = await open("readonly");
    let refused: { isError?: boolean; text: string } | undefined;
    const c = await t.withVerifier(async (_input, ctx) => {
      const { result } = await ctx.callTool("shell", { command: "touch ran.txt" });
      refused = {
        isError: result.isError,
        text: result.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
      };
      return { ok: false, outputHash: hash(refused.text) };
    });
    await t.verify(c.criterionId);
    expect(refused?.isError).toBe(true);
    expect(existsSync(join(t.fx.root, "ran.txt"))).toBe(false);
  });

  it("the context hands out no handle on the store, the registry or the host", async () => {
    const t = await open();
    let keys: string[] = [];
    const c = await t.withVerifier(async (_input, ctx) => {
      keys = Object.keys(ctx).sort();
      return { ok: true, outputHash: hash("x") };
    });
    await t.verify(c.criterionId);
    expect(keys).toEqual(["callTool", "criterionId", "sessionId", "signal", "workspace"]);
  });
});
