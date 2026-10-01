/**
 * The container runtime of `python_run` (`analysis.runtime: "oci"`): the exact `run` arguments, the
 * lifecycle with a fake container CLI (cancel and timeout `kill` the container by name and leave no
 * `alisio-*` container), the refusal paths, and, only when a real Docker or Podman and a
 * digest-pinned Python image are available (ALISIO_TEST_OCI_IMAGE), the isolation itself.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  containerName,
  type OciHost,
  OciRuntime,
  type OciSettings,
  ociRunArgs,
  parseDigests,
} from "../packages/core/src/analysis/oci.ts";
import { analysisHarness, FAKE_CONTAINER, fake } from "./analysis-run-helpers.ts";

const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE = `registry.example/python@${DIGEST}`;
const settings = (extra: Partial<OciSettings> = {}): OciSettings & { image: string } => ({
  engine: "docker",
  image: IMAGE,
  memoryMb: 2048,
  cpus: 2,
  ...extra,
});
const mounts = {
  script: "/state/jobs/exec_1/script",
  input: "/state/jobs/exec_1/input",
  work: "/state/jobs/exec_1/work",
  staging: "/state/jobs/exec_1/staging",
};
const linux: OciHost = { platform: "linux", uid: 1000, gid: 1000 };
const args = (host: OciHost = linux, s = settings(), m = mounts) =>
  ociRunArgs({ settings: s, executionId: "exec_1", mounts: m, host });

describe("ociRunArgs", () => {
  it("builds the run of spec 8.3: no network, read-only root, no capabilities, limits and mounts", () => {
    const a = args();
    expect(a.slice(0, 4)).toEqual(["run", "--rm", "--name", "alisio-exec_1"]);
    for (const flag of [
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2048m",
      "--cpus=2",
    ])
      expect(a).toContain(flag);
    expect(a).toContain("--tmpfs");
    expect(a[a.indexOf("--tmpfs") + 1]).toBe("/tmp:size=256m");
    const volumes = a.flatMap((x, i) => (x === "-v" ? [a[i + 1]] : []));
    expect(volumes).toEqual([
      `${mounts.script}:/job/script:ro`,
      `${mounts.input}:/job/input:ro`,
      `${mounts.work}:/job/work:rw`,
      `${mounts.staging}:/job/out:rw`,
    ]);
    const env = a.flatMap((x, i) => (x === "-e" ? [a[i + 1]] : []));
    expect(env).toEqual(
      expect.arrayContaining([
        "ALISIO_INPUT_DIR=/job/input",
        "ALISIO_OUTPUT_DIR=/job/out",
        "ALISIO_WORK_DIR=/job/work",
        "ALISIO_EXECUTION_ID=exec_1",
        "MPLBACKEND=Agg",
      ]),
    );
    // The image comes after every option and is followed by the interpreter command.
    const at = a.indexOf(IMAGE);
    expect(a.slice(at - 2, at)).toEqual(["-w", "/job/work"]);
    expect(a.slice(at + 1)).toEqual([
      "python",
      "-E",
      "-s",
      "-B",
      "-u",
      "-X",
      "utf8",
      "/job/script/main.py",
    ]);
    // No variable of the host and no repository mount.
    expect(a.join(" ")).not.toMatch(/OPENAI|API_KEY|\/ws\b/);
  });

  it("runs as the user on Linux, and omits --user on Docker Desktop (macOS and Windows)", () => {
    expect(args(linux)).toEqual(expect.arrayContaining(["--user", "1000:1000"]));
    expect(args({ platform: "darwin", uid: 501, gid: 20 })).not.toContain("--user");
    expect(args({ platform: "win32" }, settings(), winMounts())).not.toContain("--user");
    expect(args({ platform: "linux", uid: 0, gid: 0 })).not.toContain("--user");
  });

  it("handles rootless engines: Podman keeps the owner with keep-id, rootless Docker maps it itself", () => {
    const podman = args({ ...linux, rootless: true }, settings({ engine: "podman" }));
    expect(podman).toEqual(expect.arrayContaining(["--userns=keep-id", "--user", "1000:1000"]));
    expect(args({ ...linux, rootless: true })).not.toContain("--user");
    expect(args(linux, settings({ engine: "podman" }))).not.toContain("--userns=keep-id");
  });

  it("relabels the mounts only when SELinux is enforcing", () => {
    expect(args({ ...linux, selinux: true }).join(" ")).toContain(":/job/work:rw,z");
    expect(args(linux).join(" ")).not.toContain(",z");
  });

  function winMounts() {
    return {
      script: "C:\\Users\\Ana Gómez\\state\\jobs\\exec_1\\script",
      input: "C:\\Users\\Ana Gómez\\state\\jobs\\exec_1\\input",
      work: "C:\\Users\\Ana Gómez\\state\\jobs\\exec_1\\work",
      staging: "C:\\Users\\Ana Gómez\\state\\jobs\\exec_1\\staging",
    };
  }

  it("keeps paths with spaces and non-ASCII names as single arguments (Windows drive letters included)", () => {
    const a = args({ platform: "win32" }, settings(), winMounts());
    expect(a).toContain("C:\\Users\\Ana Gómez\\state\\jobs\\exec_1\\work:/job/work:rw");
    const spaced = { ...mounts, work: "/home/ana maría/state/exec_1/work" };
    expect(args(linux, settings(), spaced)).toContain(
      "/home/ana maría/state/exec_1/work:/job/work:rw",
    );
  });

  it("refuses a host path the engine would parse as mount syntax", () => {
    expect(() => args(linux, settings(), { ...mounts, work: "/tmp/a:b/work" })).toThrow(
      /cannot mount/,
    );
  });

  it("names the container alisio-<executionId>", () => {
    expect(containerName("exec_01J")).toBe("alisio-exec_01J");
    expect(containerName("exec/../x")).toBe("alisio-exec-..-x");
  });

  it("parses the digests an engine reports for an image", () => {
    expect(parseDigests(`["repo@${DIGEST}"]`)).toEqual([`repo@${DIGEST}`]);
    expect(parseDigests("[]")).toEqual([]);
    expect(parseDigests("not json")).toEqual([]);
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** `python_run` in container mode with the fake container CLI (and a fake host Python that must not be used). */
async function ociHarness(options: { engineMissing?: boolean; image?: string | null } = {}) {
  const engineState = await mkdtemp(join(tmpdir(), "alisio-fake-engine-"));
  const runtime = new OciRuntime(
    {
      engine: "docker",
      memoryMb: 512,
      cpus: 1,
      ...(options.image === null ? {} : { image: options.image ?? IMAGE }),
    },
    {
      locate: async (engine) =>
        options.engineMissing
          ? engine === "podman"
            ? "/usr/bin/podman"
            : undefined
          : process.execPath,
      prefixArgs: [FAKE_CONTAINER, engineState],
      host: async () => ({ platform: process.platform, uid: 1000, gid: 1000 }),
    },
  );
  let hostPythonUsed = false;
  const h = await analysisHarness({
    deps: {
      runtime: {
        interpreter: async () => {
          hostPythonUsed = true;
          return { ok: false, reason: "no host python in container mode" };
        },
      },
      oci: { mode: () => "oci", runtime: () => runtime },
    },
  });
  cleanups.push(async () => {
    await h.dispose();
    await rm(engineState, { recursive: true, force: true });
  });
  const calls = async () =>
    (await readFile(join(engineState, "calls.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  return { h, runtime, calls, hostPythonUsed: () => hostPythonUsed };
}

describe("python_run in container mode (fake container CLI)", () => {
  it("runs the job in a container without host Python and records the runtime in the provenance", async () => {
    const { h, calls, hostPythonUsed } = await ociHarness();
    const { text, result } = await h.run({
      code: fake({ files: { "report.md": "# from the container\n" }, stdout: "hi\n" }),
    });
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/^exit 0 .* published 1 artifact: report\.md/);
    expect(hostPythonUsed()).toBe(false);
    const run = (await calls()).find((c) => c[0] === "run") as string[];
    expect(run).toEqual(expect.arrayContaining(["--network=none", "--read-only", IMAGE]));
    expect(run).toContain("--memory=512m");
    expect(run.some((a) => a.endsWith(":/job/out:rw"))).toBe(true);
    const [execution] = h.executions();
    expect(execution).toMatchObject({ runtime: "oci", status: "completed", exit_code: 0 });
    const [artifact] = h.artifacts.list(h.store.rootOf(h.session));
    expect(artifact?.provenance.runtime).toMatchObject({
      mode: "oci",
      engine: "docker",
      image: IMAGE,
    });
    expect(await readFile(h.artifacts.localPath(artifact as never), "utf8")).toBe(
      "# from the container\n",
    );
  });

  it("cancelling kills the container by name and leaves no alisio-* container", async () => {
    const { h, runtime, calls } = await ociHarness();
    const controller = new AbortController();
    const started = h.run(
      { code: fake({ sleepMs: 60_000, files: { "late.txt": "x" } }) },
      controller.signal,
    );
    // The container is up once its marker exists.
    for (let i = 0; i < 100 && (await runtime.leftovers()).length === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await runtime.leftovers()).toHaveLength(1);
    const began = Date.now();
    controller.abort(new Error("Cancelled"));
    // The cancelled call ends as an error result of the tool (the run stays consistent).
    expect((await started).result.isError).toBe(true);
    expect(Date.now() - began).toBeLessThan(10_000);
    const kills = (await calls()).filter((c) => c[0] === "kill");
    expect(kills.length).toBeGreaterThan(0);
    expect(kills[0]?.[1]).toMatch(/^alisio-exec_/);
    expect(await runtime.leftovers()).toEqual([]);
    expect(h.executions()[0]).toMatchObject({ status: "cancelled" });
    expect(h.artifacts.list(h.store.rootOf(h.session))).toHaveLength(0);
  });

  it("a timeout also kills the container and reports timed_out", async () => {
    const { h, runtime, calls } = await ociHarness();
    const { text, result } = await h.run({ code: fake({ sleepMs: 60_000 }), timeoutMs: 1000 });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/timed out after 1s/);
    expect((await calls()).some((c) => c[0] === "kill")).toBe(true);
    expect(await runtime.leftovers()).toEqual([]);
    expect(h.executions()[0]).toMatchObject({ status: "timed_out" });
  });

  it("reports an engine that is not installed, suggesting the other one, and runs nothing", async () => {
    const { h } = await ociHarness({ engineMissing: true });
    const { text, result } = await h.run({ code: fake({}) });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/runtime_unavailable: docker was not found on PATH; podman is installed/);
    expect(text).toMatch(/analysis\.oci\.engine/);
    expect(h.executions()).toHaveLength(0);
  });

  it("asks for an image when none is configured and runs nothing", async () => {
    const { h } = await ociHarness({ image: null });
    const { text } = await h.run({ code: fake({}) });
    expect(text).toMatch(/analysis\.oci\.image is not set/);
    expect(h.executions()).toHaveLength(0);
  });

  it("the container exit code is the run's exit code", async () => {
    const { h } = await ociHarness();
    const { text, result } = await h.run({ code: fake({ exit: 3, stderr: "boom\n" }) });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/exit 3/);
    expect(h.executions()[0]).toMatchObject({ status: "failed", exit_code: 3 });
  });
});

// ---- a real engine -------------------------------------------------------------------------
const REAL_IMAGE = process.env.ALISIO_TEST_OCI_IMAGE;
const REAL_ENGINE = process.env.ALISIO_TEST_OCI_ENGINE === "podman" ? "podman" : "docker";
const realEngine =
  !!REAL_IMAGE &&
  spawnSync(REAL_ENGINE, ["version"], { stdio: "ignore", timeout: 15_000 }).status === 0;

describe.skipIf(!realEngine)(
  `python_run in a real ${REAL_ENGINE} container (needs ALISIO_TEST_OCI_IMAGE, a digest-pinned Python image, and a running engine)`,
  () => {
    async function real() {
      const runtime = new OciRuntime({
        engine: REAL_ENGINE,
        image: REAL_IMAGE as string,
        memoryMb: 512,
        cpus: 1,
      });
      const h = await analysisHarness({
        deps: {
          runtime: { interpreter: async () => ({ ok: false, reason: "container only" }) },
          oci: { mode: () => "oci", runtime: () => runtime },
        },
      });
      cleanups.push(() => h.dispose());
      return { h, runtime };
    }

    it("a script that opens a network connection fails", async () => {
      const { h } = await real();
      const { text } = await h.run({
        code: [
          "import socket, sys",
          "try:",
          "    socket.create_connection(('1.1.1.1', 53), timeout=3)",
          "    print('CONNECTED')",
          "except OSError as e:",
          "    print('NO_NETWORK', type(e).__name__)",
          "    sys.exit(0)",
        ].join("\n"),
      });
      expect(text).toContain("NO_NETWORK");
      expect(text).not.toContain("CONNECTED");
    }, 60_000);

    it("writes under /job/out and /job/work, but not elsewhere", async () => {
      const { h } = await real();
      const { text, result } = await h.run({
        code: [
          "import os",
          "open(os.path.join(os.environ['ALISIO_OUTPUT_DIR'], 'ok.txt'), 'w').write('ok')",
          "open(os.path.join(os.environ['ALISIO_WORK_DIR'], 'scratch.txt'), 'w').write('ok')",
          "for target in ('/etc/alisio-test', '/usr/alisio-test', '/job/script/x', '/job/input/x'):",
          "    try:",
          "        open(target, 'w').write('x')",
          "        print('WROTE', target)",
          "    except OSError:",
          "        print('BLOCKED', target)",
        ].join("\n"),
      });
      expect(result.isError).toBeFalsy();
      expect(text).toContain("BLOCKED /etc/alisio-test");
      expect(text).toContain("BLOCKED /usr/alisio-test");
      expect(text).toContain("BLOCKED /job/script/x");
      expect(text).toContain("BLOCKED /job/input/x");
      expect(text).not.toContain("WROTE");
      expect(text).toMatch(/published 1 artifact: ok\.txt/);
    }, 60_000);

    it("cancelling leaves no alisio-* container", async () => {
      const { h, runtime } = await real();
      const controller = new AbortController();
      const run = h.run({ code: "import time\ntime.sleep(120)\n" }, controller.signal);
      for (let i = 0; i < 100 && (await runtime.leftovers()).length === 0; i++)
        await new Promise((r) => setTimeout(r, 200));
      expect((await runtime.leftovers()).length).toBe(1);
      controller.abort(new Error("Cancelled"));
      expect((await run).result.isError).toBe(true);
      expect(await runtime.leftovers()).toEqual([]);
    }, 90_000);
  },
);
