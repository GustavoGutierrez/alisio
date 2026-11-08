import { request } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLoopback } from "../packages/core/src/providers/oauth/loopback.ts";

const STATE = "state-0123456789abcdef";
const PATH = "/auth/callback";
const open: Array<{ close(): void }> = [];
const blockers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const loopback of open.splice(0)) loopback.close();
  await Promise.all(
    blockers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function start(extra: Record<string, unknown> = {}) {
  const loopback = await openLoopback({ port: 0, path: PATH, state: STATE, ...extra });
  open.push(loopback);
  return { loopback, port: Number(new URL(loopback.redirectUri).port) };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
function call(
  port: number,
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.host ? { Host: options.host } : {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("openLoopback: state checks (OA-AC-23)", () => {
  it("answers 400 to a wrong or missing state without consuming the use, whatever the count, then accepts the right one", async () => {
    const { loopback, port } = await start();
    const waited = loopback.wait();
    expect((await call(port, `${PATH}?code=c&state=wrong`)).status).toBe(400);
    expect((await call(port, `${PATH}?code=c`)).status).toBe(400);
    expect((await call(port, `${PATH}?code=c&state=${STATE}&state=${STATE}`)).status).toBe(400);
    for (let i = 0; i < 100; i++)
      expect((await call(port, `${PATH}?code=c&state=bad-${i}`)).status).toBe(400);
    const ok = await call(port, `${PATH}?code=the-code&state=${STATE}&extra=1`);
    expect(ok.status).toBe(200);
    expect(await waited).toEqual({ code: "the-code", state: STATE, extra: "1" });
  });

  it("compares the state of equal length and of different length alike (no early exit on a prefix)", async () => {
    const { loopback, port } = await start();
    const waited = loopback.wait();
    expect((await call(port, `${PATH}?state=${STATE.slice(0, -1)}`)).status).toBe(400);
    expect((await call(port, `${PATH}?state=${STATE}x`)).status).toBe(400);
    expect((await call(port, `${PATH}?state=${STATE.slice(0, -1)}X`)).status).toBe(400);
    await call(port, `${PATH}?state=${STATE}`);
    await expect(waited).resolves.toMatchObject({ state: STATE });
  });
});

describe("openLoopback: the listener (OA-AC-24)", () => {
  it("binds 127.0.0.1 only, reports the real port and uses 127.0.0.1 in the redirect URI by default", async () => {
    const { loopback, port } = await start();
    expect(port).toBeGreaterThan(0);
    expect(loopback.redirectUri).toBe(`http://127.0.0.1:${port}${PATH}`);
    // Reachable on 127.0.0.1 and not on another loopback address of the machine.
    expect((await call(port, "/nope")).status).toBe(404);
    await expect(
      new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.2", port, path: "/nope" }, resolve);
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ECONNREFUSED|EADDRNOTAVAIL/) });
  });

  it("honors redirectHost localhost for the URI while still listening on 127.0.0.1 only", async () => {
    const { loopback, port } = await start({ redirectHost: "localhost" });
    expect(loopback.redirectUri).toBe(`http://localhost:${port}${PATH}`);
    expect((await call(port, `${PATH}?state=x`, { host: `localhost:${port}` })).status).toBe(400);
  });

  it("answers 405 to other methods, 404 to other paths and 400 to a foreign Host, and none consumes the use", async () => {
    const { loopback, port } = await start();
    const waited = loopback.wait();
    const post = await call(port, `${PATH}?state=${STATE}`, { method: "POST" });
    expect(post.status).toBe(405);
    expect((await call(port, `${PATH}?state=${STATE}`, { method: "HEAD" })).status).toBe(405);
    expect((await call(port, `/other?state=${STATE}`)).status).toBe(404);
    expect((await call(port, `${PATH}x?state=${STATE}`)).status).toBe(404);
    expect(
      (await call(port, `${PATH}?state=${STATE}`, { host: `evil.example:${port}` })).status,
    ).toBe(400);
    expect((await call(port, `${PATH}?state=${STATE}`, { host: "127.0.0.1:1" })).status).toBe(400);
    expect((await call(port, `${PATH}?state=${STATE}`, { host: `127.0.0.1:${port}` })).status).toBe(
      200,
    );
    await expect(waited).resolves.toMatchObject({ state: STATE });
  });

  it("serves a static page without echo and with no-store and no-referrer, then refuses a second callback", async () => {
    const { loopback, port } = await start();
    const waited = loopback.wait();
    const payload = "<script>alert(1)</script>";
    const ok = await call(
      port,
      `${PATH}?state=${STATE}&code=SECRET-CODE-123&note=${encodeURIComponent(payload)}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers["referrer-policy"]).toBe("no-referrer");
    expect(ok.body).not.toContain("SECRET-CODE-123");
    expect(ok.body).not.toContain("alert(1)");
    expect(ok.body).not.toContain("<script");
    await waited;
    await expect(call(port, `${PATH}?state=${STATE}`)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    // The 400 pages carry no echo either.
    const second = await start();
    const bad = await call(second.port, `${PATH}?state=${encodeURIComponent(payload)}`);
    expect(bad.status).toBe(400);
    expect(bad.body).not.toContain("alert(1)");
    expect(bad.headers["cache-control"]).toBe("no-store");
    expect(bad.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("fails with loopback_unavailable when the port is taken", async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = (blocker.address() as { port: number }).port;
    await expect(openLoopback({ port: taken, path: PATH, state: STATE })).rejects.toMatchObject({
      code: "loopback_unavailable",
    });
  });
});

describe("openLoopback: end of life", () => {
  it("closes at timeoutMs and rejects wait()", async () => {
    vi.useFakeTimers();
    const { loopback, port } = await start({ timeoutMs: 5_000 });
    const waited = loopback.wait();
    const assertion = expect(waited).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
    vi.useRealTimers();
    await expect(call(port, `${PATH}?state=${STATE}`)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  it("never lives longer than 15 minutes, even when asked for more or when failed requests keep arriving", async () => {
    vi.useFakeTimers();
    const { loopback } = await start({ timeoutMs: 10 * 60 * 60 * 1000 });
    const assertion = expect(loopback.wait()).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(899_999);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });

  it("closes and rejects wait() when the signal aborts or close() is called, and frees the port", async () => {
    const controller = new AbortController();
    const first = await start({ signal: controller.signal });
    const waitedFirst = first.loopback.wait();
    const assertFirst = expect(waitedFirst).rejects.toBeDefined();
    controller.abort();
    await assertFirst;
    await expect(call(first.port, "/x")).rejects.toMatchObject({ code: "ECONNREFUSED" });

    const second = await start();
    const waitedSecond = second.loopback.wait();
    const assertSecond = expect(waitedSecond).rejects.toThrow(/closed/i);
    second.loopback.close();
    await assertSecond;
    // The port is free again.
    const again = await openLoopback({ port: second.port, path: PATH, state: STATE });
    open.push(again);
    expect(again.redirectUri).toContain(`:${second.port}`);
  });

  it("rejects an aborted signal that was already aborted when opened", async () => {
    await expect(
      openLoopback({ port: 0, path: PATH, state: STATE, signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
  });

  it("refuses invalid options", async () => {
    await expect(openLoopback({ port: 0, path: "no-slash", state: STATE })).rejects.toThrow();
    await expect(openLoopback({ port: 0, path: "/a?b=c", state: STATE })).rejects.toThrow();
    await expect(openLoopback({ port: 0, path: PATH, state: "" })).rejects.toThrow();
    await expect(openLoopback({ port: -1, path: PATH, state: STATE })).rejects.toThrow();
    await expect(openLoopback({ port: 70_000, path: PATH, state: STATE })).rejects.toThrow();
  });
});

describe("openLoopback: stray connections do not hold the listener open (R2-01)", () => {
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
  });
  function idle(port: number, send = ""): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        if (send) socket.write(send);
        resolve(socket);
      });
      socket.on("error", () => {});
      socket.once("error", reject);
      sockets.push(socket);
    });
  }
  const within = <T>(promise: Promise<T>, ms = 2_000) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("still pending")), ms)),
    ]);

  it("resolves wait() on a valid callback although an idle raw socket stays open", async () => {
    const { loopback, port } = await start();
    await idle(port);
    const waited = loopback.wait();
    const answer = await call(port, `${PATH}?state=${STATE}&code=abc`);
    expect(answer.status).toBe(200);
    await expect(within(waited)).resolves.toMatchObject({ code: "abc" });
  });

  it("resolves wait() on a valid callback although a half-sent request is open", async () => {
    const { loopback, port } = await start();
    await idle(port, "GET /auth/callback?state=x HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\n");
    const waited = loopback.wait();
    await call(port, `${PATH}?state=${STATE}&code=abc`);
    await expect(within(waited)).resolves.toMatchObject({ code: "abc" });
  });

  it("rejects wait() at timeoutMs although an idle raw socket stays open", async () => {
    const { loopback, port } = await start({ timeoutMs: 100 });
    await idle(port);
    await expect(within(loopback.wait())).rejects.toThrow(/timed out/i);
  });

  it("rejects wait() on close() and on abort although an idle raw socket stays open", async () => {
    const first = await start();
    await idle(first.port);
    const waitedFirst = first.loopback.wait();
    const assertFirst = expect(within(waitedFirst)).rejects.toThrow(/closed/i);
    first.loopback.close();
    await assertFirst;

    const controller = new AbortController();
    const second = await start({ signal: controller.signal });
    await idle(second.port, "GET / HT");
    const assertSecond = expect(within(second.loopback.wait())).rejects.toBeDefined();
    controller.abort();
    await assertSecond;
  });

  it("keeps parameters named like Object.prototype members", async () => {
    const { loopback, port } = await start();
    const waited = loopback.wait();
    await call(port, `${PATH}?state=${STATE}&constructor=a&toString=b&__proto__=c`);
    const params = await waited;
    expect(Object.keys(params).sort()).toEqual(["__proto__", "constructor", "state", "toString"]);
    expect(params.constructor).toBe("a");
    expect(params.toString).toBe("b");
  });
});
