/**
 * The pinned QuickJS WASM (spec D17, D-22, FJ-AC-18): the bytes are hashed before anything is
 * compiled, a mismatch makes the engine "not ready" with an actionable reason, and an engine that
 * is not ready never runs code.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { JavaScriptEngine } from "../packages/core/src/forge/javascript/engine.ts";
import { IsolateHostFactory } from "../packages/core/src/forge/javascript/hosts/factory.ts";
import {
  QUICKJS_WASI_VERSION,
  QUICKJS_WASM_BYTES,
  QUICKJS_WASM_SHA256,
} from "../packages/core/src/forge/javascript/runtime-manifest.ts";
import {
  compileVerifiedModule,
  resolveWasmPath,
  wasmProblem,
} from "../packages/core/src/forge/javascript/wasm.ts";
import { EngineRegistry } from "../packages/core/src/forge/registry.ts";
import { kernelFixture } from "./forge-kernel-helpers.ts";

const realBytes = async () => new Uint8Array(await readFile(await resolveWasmPath()));

describe("runtime manifest", () => {
  it("pins the audited build: version, size and hash of the file the package ships", async () => {
    const bytes = await realBytes();
    expect(QUICKJS_WASI_VERSION).toBe("3.6.2");
    expect(bytes.byteLength).toBe(QUICKJS_WASM_BYTES);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(QUICKJS_WASM_SHA256);
    expect(wasmProblem(bytes)).toBeUndefined();
  });
});

describe("FJ-AC-18: a WASM that is not the pinned one is never compiled", () => {
  it("rejects a flipped byte, a truncated file and an empty one, naming what differs", async () => {
    const bytes = await realBytes();
    const flipped = bytes.slice();
    flipped[1000] = (flipped[1000] ?? 0) ^ 0xff;
    expect(wasmProblem(flipped)).toMatch(/hash .* does not match the pinned/);
    expect(wasmProblem(bytes.slice(0, 100))).toMatch(/has 100 bytes, expected 637405/);
    expect(wasmProblem(new Uint8Array())).toMatch(/has 0 bytes/);
  });

  it("compileVerifiedModule refuses tampered bytes and accepts the real ones", async () => {
    const bytes = await realBytes();
    const flipped = bytes.slice();
    flipped[5000] = (flipped[5000] ?? 0) ^ 1;
    await expect(compileVerifiedModule(async () => flipped)).rejects.toThrow(/does not match/);
    await expect(compileVerifiedModule(async () => bytes)).resolves.toBeInstanceOf(
      WebAssembly.Module,
    );
  });

  it("an engine over a failing module reports itself not ready, registers as unavailable and never runs", async () => {
    const hosts = new IsolateHostFactory({
      choice: "worker",
      module: async () => {
        throw new Error("unused");
      },
    });
    const engine = new JavaScriptEngine({
      hosts,
      loadModule: async () => {
        throw new Error("quickjs.wasm hash abc does not match the pinned def");
      },
    });
    const described = await engine.describe();
    expect(described.ready).toBe(false);
    expect(described.reason).toMatch(
      /failed verification.*does not match the pinned.*reinstall @alisio\/core/,
    );
    const registry = new EngineRegistry();
    const descriptor = await registry.register(engine);
    expect(descriptor.ready).toBe(false);
    await expect(
      registry
        .get("javascript-quickjs")
        .prepare({ language: "javascript", source: "return 1" }, {} as never),
    ).rejects.toThrow(/failed verification/);
  });

  it("through the kernel, an unavailable engine ends the call with ENGINE_UNAVAILABLE and the reason", async () => {
    const fx = await kernelFixture({ config: { enabled: false } });
    try {
      const result = await fx.run("return 1;");
      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({
        code: "ENGINE_UNAVAILABLE",
        message: "disabled by config",
      });
      expect(fx.journal.get(result.executionId)?.status).toBe("failed");
    } finally {
      await fx.close();
    }
  });
});
