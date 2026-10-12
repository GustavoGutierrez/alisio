/**
 * The scratchpad provider and the janitor roots (spec §9.4): one folder per ROOT session, created
 * lazily and once, no folder means no scratchpad, and the shared temporary root is swept only for
 * the user's default store.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScratchpadProvider,
  scratchSweepRoots,
} from "../packages/core/src/forge/scratch-provider.ts";

let base: string;
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const setup = async () => {
  base = await mkdtemp(join(tmpdir(), "alisio-scratch-provider-"));
  const parents: Record<string, string> = { child: "root-1", grandchild: "child" };
  const calls: string[] = [];
  const diagnostics: string[] = [];
  const provider = createScratchpadProvider({
    rootOf: (id) => {
      let current = id;
      while (parents[current]) current = parents[current] as string;
      return current;
    },
    workspaceOf: (id) => {
      calls.push(id);
      return join(base, "ws");
    },
    workspaceKey: () => "wk",
    stateHome: join(base, "state"),
    configRoot: () => join(base, "tmp"),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return { provider, calls, diagnostics };
};

describe("scratchpad provider", () => {
  it("gives every session of a tree the scratchpad of its root, built once", async () => {
    const { provider, calls } = await setup();
    const a = await provider("root-1");
    expect(await provider("child")).toBe(a);
    expect(await provider("grandchild")).toBe(a);
    expect(calls).toEqual(["root-1"]);
    expect(a?.startsWith(join(base, "tmp"))).toBe(true);
    expect(a?.endsWith(join("root-1", "scratchpad"))).toBe(true);
    expect((await stat(a ?? "")).isDirectory()).toBe(true);
  });

  it("answers undefined, and retries later, when no folder can be made", async () => {
    const { provider } = await setup();
    const broken = createScratchpadProvider({
      rootOf: () => "../not-a-safe-id",
      workspaceOf: () => join(base, "ws"),
      workspaceKey: () => "wk",
      stateHome: join(base, "state"),
      configRoot: () => null,
    });
    expect(await broken("x")).toBeUndefined();
    expect(await provider("root-2")).toBeDefined();
  });

  it("reports the fallback diagnostic when the shared root is not trusted", async () => {
    const { diagnostics } = await setup();
    const provider = createScratchpadProvider({
      rootOf: (id) => id,
      workspaceOf: () => join(base, "ws"),
      workspaceKey: () => "wk",
      stateHome: join(base, "state"),
      // A file where the shared temporary root should be: it cannot be used.
      configRoot: () => join(base, "state", "sessions.sqlite", "nope"),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    await mkdirState();
    const pad = await provider("root-9");
    expect(pad?.startsWith(join(base, "state", "scratch"))).toBe(true);
    expect(diagnostics[0]).toContain("Shared scratch root not used");
  });
});

async function mkdirState() {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(base, "state"), { recursive: true });
  await writeFile(join(base, "state", "sessions.sqlite"), "not a directory");
}

describe("scratch sweep roots", () => {
  it("sweeps the per-user temporary root and the state fallback for the default store", () => {
    const roots = scratchSweepRoots({
      customStore: false,
      stateHome: "/state",
      configRoot: null,
      env: {},
      platform: "linux",
      uid: 1000,
      osTmpdir: "/tmp",
    });
    expect(roots).toEqual(["/tmp/alisio-1000", "/state/scratch"]);
  });

  it("honours ALISIO_TMPDIR over the configured root, and drops the user suffix on Windows", () => {
    const base = { customStore: false, stateHome: "/s", configRoot: "/cfg", osTmpdir: "/t" };
    expect(
      scratchSweepRoots({ ...base, env: { ALISIO_TMPDIR: "/env" }, platform: "linux", uid: 7 })[0],
    ).toBe("/env/alisio-7");
    expect(scratchSweepRoots({ ...base, env: {}, platform: "linux", uid: 7 })[0]).toBe(
      "/cfg/alisio-7",
    );
    expect(scratchSweepRoots({ ...base, env: {}, platform: "win32" })[0]).toBe(
      join("/cfg", "alisio"),
    );
  });

  it("leaves the shared temporary root alone for a custom store", () => {
    expect(
      scratchSweepRoots({ customStore: true, stateHome: "/s", configRoot: null, env: {} }),
    ).toEqual(["/s/scratch"]);
  });
});
