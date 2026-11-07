import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchHost, type RunningHost } from "../apps/desktop/src/host-process.ts";
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
