import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchHost, type RunningHost } from "../apps/desktop/src/host-process.ts";
import { installOutputRedaction } from "../apps/desktop/src/redact-output.ts";
import { buildHostSpawn } from "../apps/desktop/src/spawn-plan.ts";

const HOST_SOURCE = join(import.meta.dirname, "..", "apps", "desktop", "src", "host.ts");
const NODE_ARGS = [
  "--conditions=alisio-source",
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
];
/** The Electron binary of apps/desktop when its postinstall download ran; undefined otherwise. */
function electronBinary(): string | undefined {
  try {
    const path = createRequire(join(import.meta.dirname, "..", "apps", "desktop", "package.json"))(
      "electron",
    ) as string;
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}
const ELECTRON = electronBinary();
const homes: string[] = [];
let running: RunningHost | undefined;

function hermeticEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "alisio-desktop-test-"));
  homes.push(home);
  return {
    ...process.env,
    ALISIO_CONFIG_HOME: join(home, "config"),
    ALISIO_STATE_HOME: join(home, "state"),
    HOME: home,
  };
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("desktop host process", () => {
  it("starts the server on a free loopback port, serves the launch URL and exits cleanly on SIGTERM", async () => {
    const plan = buildHostSpawn({
      execPath: process.execPath,
      hostEntry: HOST_SOURCE,
      parentEnv: hermeticEnv(),
      nodeArgs: NODE_ARGS,
    });
    running = await launchHost({ ...plan, timeoutMs: 20_000 });
    const url = new URL(running.launchUrl);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.searchParams.get("token")).toBeTruthy();

    const response = await fetch(running.launchUrl, { redirect: "manual" });
    expect(response.status).toBeLessThan(400);
    const health = await fetch(`${url.origin}/api/health`);
    expect(health.status).toBe(200);

    const code = await running.stop();
    expect(code).toBe(0);
    running = undefined;
  });

  it.skipIf(!ELECTRON)(
    "runs the same host on the Electron binary with ELECTRON_RUN_AS_NODE and serves HTTP 200",
    async () => {
      const plan = buildHostSpawn({
        execPath: ELECTRON as string,
        hostEntry: HOST_SOURCE,
        parentEnv: hermeticEnv(),
        nodeArgs: NODE_ARGS,
      });
      running = await launchHost({ ...plan, timeoutMs: 25_000 });
      const health = await fetch(new URL("/api/health", running.launchUrl));
      expect(health.status).toBe(200);
      expect(await running.stop()).toBe(0);
      running = undefined;
    },
  );

  it("reports a failure to start as an error instead of hanging", async () => {
    await expect(
      launchHost({
        command: process.execPath,
        args: ["-e", "process.send({type:'error',message:'no luck'}); process.exit(3)"],
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/no luck/);
  });

  it("rejects when the host exits before it is ready", async () => {
    await expect(
      launchHost({
        command: process.execPath,
        args: ["-e", "process.exit(2)"],
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited/);
  });

  it("rejects and kills a host that never becomes ready", async () => {
    await expect(
      launchHost({
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: process.env,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/did not become ready/);
  });

  it("ignores ready messages that are not loopback URLs", async () => {
    await expect(
      launchHost({
        command: process.execPath,
        args: [
          "-e",
          "process.send({type:'ready',launchUrl:'https://evil.example/'}); setTimeout(()=>process.exit(0),200)",
        ],
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited/);
  });

  it("falls back to a JSON stdout line when there is no IPC channel", async () => {
    const child = spawn(process.execPath, [...NODE_ARGS, HOST_SOURCE], {
      env: hermeticEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => reject(new Error("no ready line")), 20_000);
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const first = buffer.split("\n").find((l) => l.startsWith("{"));
          if (first) {
            clearTimeout(timer);
            resolve(first);
          }
        });
        child.on("exit", () => reject(new Error("exited early")));
      });
      const message = JSON.parse(line) as { type: string; launchUrl: string };
      expect(message.type).toBe("ready");
      expect((await fetch(new URL("/api/health", message.launchUrl))).status).toBe(200);
    } finally {
      const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    }
  });
});

// OA-AC-57 (Desktop): the host's stdout and stderr never carry a token.
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OSJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1";

/** A preload that prints a JWT on both streams once the host has installed its redaction. */
function leakingEnv(): NodeJS.ProcessEnv {
  const env = hermeticEnv();
  const dir = mkdtempSync(join(tmpdir(), "alisio-desktop-preload-"));
  homes.push(dir);
  const preload = join(dir, "leak.cjs");
  writeFileSync(
    preload,
    `setTimeout(() => { process.stderr.write("leak-stderr ${JWT}\\n"); process.stdout.write("leak-stdout ${JWT}\\n"); }, 700).unref();`,
  );
  return { ...env, NODE_OPTIONS: `--require ${preload}` };
}

describe("desktop host output redaction (OA-AC-57)", () => {
  it("redacts the text a plugin or a library writes to the host's stderr and stdout", async () => {
    const lines: string[] = [];
    const plan = buildHostSpawn({
      execPath: process.execPath,
      hostEntry: HOST_SOURCE,
      parentEnv: leakingEnv(),
      nodeArgs: NODE_ARGS,
    });
    const child = spawn(plan.command, plan.args, {
      env: plan.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const out: string[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no leak lines")), 20_000);
        const check = setInterval(() => {
          if (out.join("").includes("leak-stdout") && lines.join("").includes("leak-stderr")) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 25);
        child.on("exit", () => reject(new Error("exited early")));
      });
      expect(out.join("")).toContain("leak-stdout [redacted]");
      expect(lines.join("")).toContain("leak-stderr [redacted]");
      expect(out.join("")).not.toContain(JWT);
      expect(lines.join("")).not.toContain(JWT);
    } finally {
      const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
      child.kill("SIGTERM");
      await exited;
    }
  });

  it("wraps a stream's write: strings and buffers are redacted, callbacks and return values kept", () => {
    const written: string[] = [];
    const stream = {
      write(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
        written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        for (const arg of rest) if (typeof arg === "function") (arg as () => void)();
        return true;
      },
    };
    const restore = installOutputRedaction(
      (text) => text.replaceAll("SECRET-VALUE-1", "[redacted]"),
      [stream],
    );
    let called = 0;
    expect(stream.write("a SECRET-VALUE-1 b", () => called++)).toBe(true);
    stream.write(Buffer.from("buffer SECRET-VALUE-1"), "utf8", () => called++);
    const untouched = Buffer.from([0xff, 0xfe, 0x00]);
    stream.write(untouched);
    expect(written[0]).toBe("a [redacted] b");
    expect(written[1]).toBe("buffer [redacted]");
    expect(called).toBe(2);
    expect(written).toHaveLength(3);
    restore();
    stream.write("SECRET-VALUE-1");
    expect(written.at(-1)).toBe("SECRET-VALUE-1");
  });
});
