/**
 * The session scratchpad as an authorized write root (spec §9.4, FJ-AC-31): with Forja on, a write
 * confined to the root session's verified scratchpad never asks, in any mode; `--read-only` and a
 * run that cannot ask keep their denial; a symlink out of the scratchpad is "outside"; with Forja
 * off nothing changes.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Policy } from "../packages/core/src/core/contracts.ts";
import { createNestedDispatcher } from "../packages/core/src/forge/nested.ts";
import { ensureSessionDir } from "../packages/core/src/forge/session-dir.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { Skills } from "../packages/core/src/resources/skills.ts";
import { PathAccess } from "../packages/core/src/runtime/access.ts";
import { registerStandard } from "../packages/core/src/tools/standard.ts";
import { gateFixture } from "./forge-gate-helpers.ts";

const ask: Policy = { write: false, process: false, external: false };
let base: string;
let outside: string;
const fixtures: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "alisio-scratch-gate-")));
  outside = join(base, "elsewhere");
  await mkdir(outside);
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  await rm(base, { recursive: true, force: true });
});

interface OpenOptions {
  forge?: boolean;
  readOnly?: boolean;
  approve?: false;
  policy?: Policy;
  /** `forge.scratch.maxBytes` */
  maxBytes?: number;
}

async function open(options: OpenOptions = {}) {
  const dirs: string[] = [];
  const dirAsks: string[] = [];
  let workspace = "";
  const scratchpad = async (session: string) => {
    const dir = await ensureSessionDir({
      rootSessionId: session,
      workspace,
      workspaceKey: "wk",
      stateHome: join(base, "state"),
      configRoot: join(base, "tmp"),
    });
    dirs.push(dir.scratchpad);
    return dir.scratchpad;
  };
  const fx = await gateFixture({
    policy: options.policy ?? { ...ask },
    ...(options.approve === false ? { approve: false as const } : {}),
    pathAccess: (root) => {
      workspace = root;
      return new PathAccess({
        workspace: root,
        approve: async (request) => {
          dirAsks.push(request.path);
          return "once";
        },
        readOnly: !!options.readOnly,
        ...(options.forge === false
          ? {}
          : { scratchpad, scratchMaxBytes: () => options.maxBytes ?? 1_000_000 }),
      });
    },
  });
  fixtures.push(fx);
  registerStandard(fx.registry, fx.root, new Skills(), new ProjectContext(fx.root));
  const pad = await scratchpad(fx.session);
  const write = (path: string, content = "x") =>
    fx.play([{ name: "write_file", arguments: { path, content, expectedHash: null } }]);
  return { fx, pad, write, dirAsks };
}

describe("scratchpad as a write root", () => {
  it("lets a write inside the scratchpad run in ask mode without any approval", async () => {
    const { fx, pad, write, dirAsks } = await open();
    const [out] = await write(join(pad, "plan.js"), "export {}");
    expect(out?.isError).toBe(false);
    expect(await readFile(join(pad, "plan.js"), "utf8")).toBe("export {}");
    expect(fx.asked).toEqual([]);
    expect(dirAsks).toEqual([]);
  });

  it("is the same for a relative path inside nested folders of the scratchpad", async () => {
    const { fx, pad, write } = await open();
    const [out] = await write(join(pad, "a", "b.js"));
    expect(out?.isError).toBe(false);
    expect(fx.asked).toEqual([]);
  });

  it("still asks for a write in the workspace, and for a directory outside every root", async () => {
    const { fx, write, dirAsks } = await open();
    await write("inside.txt");
    expect(fx.asked.map((a) => a.effect)).toEqual(["write"]);
    fx.asked.length = 0;
    await write(join(outside, "out.txt"));
    expect(dirAsks).toEqual([join(outside, "out.txt")]);
    expect(fx.asked.map((a) => a.effect)).toEqual(["write"]);
  });

  it("denies the write under --read-only", async () => {
    const { fx, pad, write } = await open({ readOnly: true, approve: false });
    const [out] = await write(join(pad, "plan.js"));
    expect(out?.isError).toBe(true);
    expect(out?.text).toMatch(/Path outside the workspace|Capability denied/);
    expect(fx.ran).toEqual([]);
  });

  it("treats a symlink that leaves the scratchpad as outside, never as the authorized root", async () => {
    const { fx, pad, write, dirAsks } = await open();
    await symlink(outside, join(pad, "link"));
    const [out] = await write(join(pad, "link", "escape.txt"));
    // It goes down the ordinary outside-directory path (which asks) and is refused there.
    expect(dirAsks).toHaveLength(1);
    expect(out).toMatchObject({ isError: true });
    expect(out?.text).toContain("Symlinks are not allowed");
    expect(fx.ran).toEqual([]);
    await expect(readFile(join(outside, "escape.txt"))).rejects.toThrow();
  });

  it("FJ-AC-31: a headless run with no approval handler can still write inside the scratchpad", async () => {
    const { pad, write } = await open({ approve: false });
    const [out] = await write(join(pad, "plan.js"), "export {}");
    expect(out?.isError).toBe(false);
    expect(await readFile(join(pad, "plan.js"), "utf8")).toBe("export {}");
  });

  it("but a headless write in the workspace is still denied", async () => {
    const { fx, write } = await open({ approve: false });
    const [out] = await write("inside.txt");
    expect(out?.text).toBe("Capability denied: write");
    expect(fx.ran).toEqual([]);
  });

  it("leaves a child run with writes denied denied", async () => {
    const { fx, pad } = await open();
    const [out] = await fx.play(
      [
        {
          name: "write_file",
          arguments: { path: join(pad, "p.js"), content: "x", expectedHash: null },
        },
      ],
      { policy: { ...ask }, approvals: false },
    );
    expect(out?.text).toBe("Capability denied: write");
  });

  it("changes nothing when Forja is off: the scratchpad is just another outside directory", async () => {
    const { fx, pad, write, dirAsks } = await open({ forge: false });
    await write(join(pad, "plan.js"));
    expect(dirAsks).toEqual([join(pad, "plan.js")]);
    expect(fx.asked.map((a) => a.effect)).toEqual(["write"]);
  });

  it("applies to a nested write too, and only inside the scratchpad", async () => {
    const { fx, pad } = await open();
    const access = new PathAccess({
      workspace: fx.root,
      scratchpad: async () => pad,
    });
    const dispatcher = createNestedDispatcher({
      registry: fx.registry,
      policy: { ...ask },
      approvals: true,
      workspace: fx.root,
      session: fx.session,
      parentCallId: "p1",
      signal: new AbortController().signal,
      pathAccess: access,
      markEffectful: () => {},
    });
    const write = (path: string) =>
      dispatcher.call({ name: "write_file", input: { path, content: "x", expectedHash: null } });
    expect((await write(join(pad, "n.js"))).ok).toBe(true);
    expect(await write("inside.txt")).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    // Headless (nobody to ask): the scratchpad still works, the workspace is a plain denial.
    const headless = createNestedDispatcher({
      registry: fx.registry,
      policy: { ...ask },
      approvals: false,
      workspace: fx.root,
      session: fx.session,
      parentCallId: "p2",
      signal: new AbortController().signal,
      pathAccess: access,
      markEffectful: () => {},
    });
    expect(
      (
        await headless.call({
          name: "write_file",
          input: { path: join(pad, "h.js"), content: "x", expectedHash: null },
        })
      ).ok,
    ).toBe(true);
    expect(
      await headless.call({
        name: "write_file",
        input: { path: "inside.txt", content: "x", expectedHash: null },
      }),
    ).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(await write(join(outside, "o.txt"))).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
    });
  });

  it("FJ-AC-34: a write that would pass the quota is denied with a clear error and nothing is deleted", async () => {
    const { pad, write } = await open({
      maxBytes: 100,
      policy: { write: true, process: false, external: false },
    });
    const [first] = await write(join(pad, "keep.txt"), "x".repeat(60));
    expect(first?.isError).toBe(false);
    const [second] = await write(join(pad, "more.txt"), "y".repeat(60));
    expect(second?.isError).toBe(true);
    expect(second?.text).toMatch(/scratchpad is full: 60 of 100 bytes/);
    expect(second?.text).toMatch(/Nothing was deleted/);
    expect(await readFile(join(pad, "keep.txt"), "utf8")).toBe("x".repeat(60));
    await expect(readFile(join(pad, "more.txt"))).rejects.toThrow();
  });

  it("replacing a file does not count its old size twice", async () => {
    const { fx, pad } = await open({ maxBytes: 100 });
    await writeFile(join(pad, "old.txt"), "x".repeat(80));
    const access = new PathAccess({
      workspace: fx.root,
      scratchpad: async () => pad,
      scratchMaxBytes: () => 100,
    });
    expect(
      await access.scratchQuotaProblem(fx.session, 90, [join(pad, "old.txt")]),
    ).toBeUndefined();
    expect(await access.scratchQuotaProblem(fx.session, 90, [])).toMatch(/full/);
    expect(
      await access.scratchQuotaProblem(fx.session, 21, [join(pad, "old.txt")]),
    ).toBeUndefined();
    expect(await access.scratchQuotaProblem(fx.session, 21, [])).toMatch(/full/);
  });

  it("the quota does not touch writes outside the scratchpad", async () => {
    const { write } = await open({
      maxBytes: 10,
      policy: { write: true, process: false, external: false },
    });
    const [out] = await write("inside.txt", "w".repeat(500));
    expect(out?.isError).toBe(false);
  });

  it("a script's nested write is bound by the quota too", async () => {
    const { fx, pad } = await open({ maxBytes: 50 });
    const access = new PathAccess({
      workspace: fx.root,
      scratchpad: async () => pad,
      scratchMaxBytes: () => 50,
    });
    const dispatcher = createNestedDispatcher({
      registry: fx.registry,
      policy: { ...ask },
      approvals: true,
      workspace: fx.root,
      session: fx.session,
      parentCallId: "q1",
      signal: new AbortController().signal,
      pathAccess: access,
      markEffectful: () => {},
    });
    const write = (name: string, size: number) =>
      dispatcher.call({
        name: "write_file",
        input: { path: join(pad, name), content: "x".repeat(size), expectedHash: null },
      });
    expect((await write("a.txt", 40)).ok).toBe(true);
    expect(await write("b.txt", 40)).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
  });

  describe("edit_file and concurrent writes against the quota (M4, L1)", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const nestedWriter = async (maxBytes: number) => {
      const { fx, pad, write } = await open({
        maxBytes,
        policy: { write: true, process: false, external: false },
      });
      const access = new PathAccess({
        workspace: fx.root,
        scratchpad: async () => pad,
        scratchMaxBytes: () => maxBytes,
      });
      const dispatcher = createNestedDispatcher({
        registry: fx.registry,
        policy: { write: true, process: false, external: false },
        approvals: false,
        workspace: fx.root,
        session: fx.session,
        parentCallId: "m4",
        signal: new AbortController().signal,
        pathAccess: access,
        markEffectful: () => {},
      });
      return { fx, pad, write, dispatcher, access };
    };

    it("M4: a nested edit_file that grows a scratch file past the quota is refused and changes nothing", async () => {
      const { pad, dispatcher } = await nestedWriter(100);
      const file = join(pad, "grow.txt");
      const content = `KEY${"x".repeat(37)}`;
      await writeFile(file, content);
      const edit = (newText: string) =>
        dispatcher.call({
          name: "edit_file",
          input: { path: file, oldText: "KEY", newText, expectedHash: sha(content) },
        });
      expect(await edit("y".repeat(200))).toMatchObject({ ok: false, code: "BUDGET_EXCEEDED" });
      expect(await readFile(file, "utf8")).toBe(content);
    });

    it("M4: an edit_file that fits, or that shrinks the file, still runs", async () => {
      const { pad, dispatcher } = await nestedWriter(100);
      const file = join(pad, "ok.txt");
      const content = `KEY${"-".repeat(57)}`;
      await writeFile(file, content);
      const grow = await dispatcher.call({
        name: "edit_file",
        input: {
          path: file,
          oldText: "KEY",
          newText: `KEY${"+".repeat(20)}`,
          expectedHash: sha(content),
        },
      });
      expect(grow.ok).toBe(true);
      const now = await readFile(file, "utf8");
      expect(now.length).toBe(80);
      const shrink = await dispatcher.call({
        name: "edit_file",
        input: { path: file, oldText: "KEY", newText: "", expectedHash: sha(now) },
      });
      expect(shrink.ok).toBe(true);
    });

    it("M4: a direct edit_file in the scratchpad is bound by the quota too", async () => {
      const { fx, pad } = await open({
        maxBytes: 100,
        policy: { write: true, process: false, external: false },
      });
      const file = join(pad, "grow.txt");
      const content = `KEY${"x".repeat(37)}`;
      await writeFile(file, content);
      const [out] = await fx.play([
        {
          name: "edit_file",
          arguments: {
            path: file,
            oldText: "KEY",
            newText: "y".repeat(200),
            expectedHash: sha(content),
          },
        },
      ]);
      expect(out?.isError).toBe(true);
      expect(out?.text).toMatch(/scratchpad is full/);
      expect(await readFile(file, "utf8")).toBe(content);
    });

    it("M4: a write-effect tool with no size estimate gets no approval-free pass into the scratchpad", async () => {
      const { fx, pad } = await open({ maxBytes: 100 });
      fx.registry.register({
        name: "blind_write",
        description: "writes somewhere; its size cannot be known beforehand",
        effect: "write",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        paths: (input) => [String(input.path)],
        async execute(input) {
          await writeFile(String(input.path), "z".repeat(5000));
          return { content: [{ type: "text", text: "ok" }] };
        },
      });
      const [out] = await fx.play([
        { name: "blind_write", arguments: { path: join(pad, "b.txt") } },
      ]);
      expect(fx.asked.map((a) => a.effect)).toEqual(["write"]);
      expect(out).toBeDefined();
    });

    it("L1: two parallel writes that each fit but not together: exactly one succeeds", async () => {
      const { pad, dispatcher } = await nestedWriter(100);
      const write = (name: string) =>
        dispatcher.call({
          name: "write_file",
          input: { path: join(pad, name), content: "x".repeat(60), expectedHash: null },
        });
      const results = await Promise.all([write("a.txt"), write("b.txt"), write("c.txt")]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.code === "BUDGET_EXCEEDED")).toHaveLength(2);
    });

    it("L1: the scratch lock serializes holders of the same scratchpad and not of another", async () => {
      const { access, pad } = await nestedWriter(100);
      const other = new PathAccess({
        workspace: pad,
        scratchpad: async () => `${pad}-other`,
        scratchMaxBytes: () => 100,
      });
      const order: string[] = [];
      const first = await access.lockScratch("s");
      const second = access.lockScratch("s").then((release) => {
        order.push("second");
        release();
      });
      const apart = await other.lockScratch("s");
      apart();
      order.push("other");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual(["other"]);
      first();
      await second;
      expect(order).toEqual(["other", "second"]);
    });
  });
});
