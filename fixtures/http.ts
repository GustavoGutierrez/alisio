/** Minimal Web Request/Response bridge over node:http, replacing Bun.serve in fixtures. */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  port: number;
  close(): Promise<void>;
}
async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  return new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
  });
}
export async function serve(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<TestServer> {
  let port = 0;
  const server = createServer(async (req, res) => {
    try {
      const response = await handler(await toRequest(req, port));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => {}));
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
/** True when the module is the process entry point (node or bun). */
export const isMain = (url: string) => {
  const entry = process.argv[1];
  return !!entry && new URL(url).pathname === new URL(`file://${entry}`).pathname;
};
