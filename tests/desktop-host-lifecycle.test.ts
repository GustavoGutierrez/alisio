import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelProblem, watchParent } from "../apps/desktop/src/host-lifecycle.ts";
import { listenOnPreferredPort, readSavedPort } from "../apps/desktop/src/port-state.ts";

const busy = () => Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });

async function portFile(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alisio-desktop-port-"));
  const file = join(dir, "host-port.json");
  if (content !== undefined) await writeFile(file, content);
  return file;
}

/** A fake server start: `taken` ports fail with EADDRINUSE, port 0 binds `free`. */
function starter(taken: number[], free = 51_234) {
  const calls: number[] = [];
  const start = async (port: number) => {
    calls.push(port);
    if (taken.includes(port)) throw busy();
    return { port: port || free };
  };
  return { calls, start, bound: (s: { port: number }) => s.port };
}

describe("desktop host port: one stable loopback origin across launches", () => {
  it("saves the port of the first launch and reuses it on the next one", async () => {
    const file = await portFile();
    const first = starter([]);
    expect(await listenOnPreferredPort(file, first.start, first.bound)).toEqual({ port: 51_234 });
    expect(first.calls).toEqual([0]);
    expect(readSavedPort(file)).toBe(51_234);
    const second = starter([]);
    await listenOnPreferredPort(file, second.start, second.bound);
    expect(second.calls).toEqual([51_234]);
  });

  it("falls back to a free port when the saved one is busy and keeps the saved one for next time", async () => {
    const file = await portFile(JSON.stringify({ port: 47_001 }));
    const run = starter([47_001], 52_000);
    expect(await listenOnPreferredPort(file, run.start, run.bound)).toEqual({ port: 52_000 });
    expect(run.calls).toEqual([47_001, 0]);
    expect(readSavedPort(file)).toBe(47_001);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ port: 47_001 });
  });

  it("treats a missing, corrupt or out-of-range file as no saved port and writes a fresh one", async () => {
    for (const content of [undefined, "{not json", JSON.stringify({ port: 80 }), '"x"', "null"]) {
      const file = await portFile(content);
      expect(readSavedPort(file)).toBeUndefined();
      const run = starter([]);
      await listenOnPreferredPort(file, run.start, run.bound);
      expect(run.calls).toEqual([0]);
      expect(readSavedPort(file)).toBe(51_234);
    }
  });

  it("does not hide other start failures and still starts when the file cannot be written", async () => {
    const file = await portFile(JSON.stringify({ port: 47_002 }));
    const broken = async () => {
      throw new Error("no database");
    };
    await expect(listenOnPreferredPort(file, broken, () => 0)).rejects.toThrow("no database");
    const dir = await mkdtemp(join(tmpdir(), "alisio-desktop-port-ro-"));
    await mkdir(join(dir, "host-port.json"));
    const run = starter([]);
    // The path is a directory: reading and writing fail, the server still starts.
    expect(await listenOnPreferredPort(join(dir, "host-port.json"), run.start, run.bound)).toEqual({
      port: 51_234,
    });
  });

  it("binds a real busy port by falling back", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = (blocker.address() as { port: number }).port;
    const file = await portFile(JSON.stringify({ port: taken }));
    const listen = (port: number) =>
      new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server));
      });
    const server = await listenOnPreferredPort(
      file,
      listen,
      (s) => (s.address() as { port: number }).port,
    );
    expect((server.address() as { port: number }).port).not.toBe(taken);
    expect(readSavedPort(file)).toBe(taken);
    await new Promise((r) => server.close(r));
    await new Promise((r) => blocker.close(r));
  });
});

describe("desktop host lifecycle: never outlive the app", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses a supervised host without an IPC channel, allows the other cases", () => {
    expect(channelProblem({ ALISIO_SUPERVISED: "1" }, false)).toMatch(/IPC/);
    expect(channelProblem({ ALISIO_SUPERVISED: "1" }, true)).toBeUndefined();
    expect(channelProblem({}, false)).toBeUndefined();
  });

  it("stops once when the original parent disappears (re-parented), and the watch is unref'd", () => {
    vi.useFakeTimers();
    let ppid = 4242;
    const onGone = vi.fn();
    const stop = watchParent({ ppid: () => ppid, onGone, intervalMs: 1_000 });
    vi.advanceTimersByTime(5_000);
    expect(onGone).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(1_000);
    expect(onGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(onGone).toHaveBeenCalledTimes(1);
    stop();
  });
});
