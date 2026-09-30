import { createHash } from "node:crypto";
import type { BlobRef, ProviderEvent } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { sniffImage } from "../packages/server/src/routes/images.ts";
import {
  fakeProvider,
  newSession,
  raw,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A 3×2 PNG header (enough for sniffing and dimensions). */
const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
  Buffer.from("rest of the image"),
]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([5, 0, 7, 0]), Buffer.alloc(8)]);

const upload = (
  s: TestServer,
  body: Buffer,
  type = "image/png",
  headers: Record<string, string> = {},
) =>
  raw(s.server.port, "/api/blobs", {
    method: "POST",
    body,
    headers: {
      Cookie: s.cookie,
      Origin: `http://127.0.0.1:${s.server.port}`,
      "Content-Type": type,
      ...headers,
    },
  });

describe("image sniffing", () => {
  it("recognizes PNG, JPEG, GIF and WebP by magic bytes and reads dimensions", () => {
    expect(sniffImage(PNG)).toEqual({ mimeType: "image/png", width: 3, height: 2 });
    expect(sniffImage(GIF)).toEqual({ mimeType: "image/gif", width: 5, height: 7 });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 9, 0, 12, 3, 0, 0, 0,
    ]);
    expect(sniffImage(jpeg)).toEqual({ mimeType: "image/jpeg", width: 12, height: 9 });
    const webp = Buffer.concat([
      Buffer.from("RIFF\0\0\0\0WEBPVP8X"),
      Buffer.alloc(8),
      Buffer.from([15, 0, 0, 9, 0, 0]),
    ]);
    expect(sniffImage(webp)).toEqual({ mimeType: "image/webp", width: 16, height: 10 });
    expect(sniffImage(Buffer.from("<svg/>"))).toBeUndefined();
    expect(sniffImage(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });
});

describe("POST /api/blobs", () => {
  it("stores an image once and returns its reference", async () => {
    t = await startTestServer();
    const res = await upload(t, PNG);
    expect(res.status).toBe(201);
    const ref = res.json<BlobRef>();
    expect(ref).toEqual({
      hash: createHash("sha256").update(PNG).digest("hex"),
      mimeType: "image/png",
      bytes: PNG.length,
      width: 3,
      height: 2,
    });
    expect((await upload(t, PNG)).json()).toEqual(ref);
  });

  it("trusts the bytes, not the declared type: a fake .png is 415", async () => {
    t = await startTestServer();
    const res = await upload(t, Buffer.from("definitely not a png"));
    expect(res.status).toBe(415);
    expect(res.json()).toMatchObject({ error: { code: "unsupported_media_type" } });
    const svg = await upload(t, Buffer.from("<svg onload=alert(1)/>"), "image/svg+xml");
    expect(svg.status).toBe(415);
    // A real GIF declared as PNG is stored with its sniffed type.
    expect((await upload(t, GIF)).json()).toMatchObject({ mimeType: "image/gif" });
  });

  it("refuses non-image content types, empty bodies and foreign origins", async () => {
    t = await startTestServer();
    expect((await upload(t, PNG, "text/plain")).status).toBe(415);
    expect((await upload(t, PNG, "application/json")).status).toBe(415);
    expect((await upload(t, Buffer.alloc(0))).status).toBe(400);
    const foreign = await upload(t, PNG, "image/png", { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const anonymous = await raw(t.server.port, "/api/blobs", {
      method: "POST",
      body: PNG,
      headers: { Origin: `http://127.0.0.1:${t.server.port}`, "Content-Type": "image/png" },
    });
    expect(anonymous.status).toBe(401);
  });

  it("answers 413 above 10 MB (declared or streamed)", async () => {
    t = await startTestServer();
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await upload(t, big);
    expect(res.status).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });
});

describe("GET /api/blobs/:hash", () => {
  it("serves stored bytes with their type, inline and cacheable", async () => {
    t = await startTestServer();
    const ref = (await upload(t, PNG)).json<BlobRef>();
    const res = await t.api.get(`/api/blobs/${ref.hash}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(res.text, "latin1").length).toBeGreaterThan(0);
    expect((await t.api.get(`/api/blobs/${"0".repeat(64)}`)).status).toBe(404);
    expect((await t.api.get("/api/blobs/..%2F..%2Fetc")).status).toBe(404);
  });
});

describe("prompts with attachments (T-09)", () => {
  it("resolves uploaded blobs into image attachments for the provider", async () => {
    const provider = fakeProvider(async function* (): AsyncGenerator<ProviderEvent> {
      yield* reply("seen");
    });
    t = await startTestServer({ provider });
    const session = await newSession(t);
    const ref = (await upload(t, PNG)).json<BlobRef>();
    const accepted = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r1",
      text: "what is this?",
      attachments: [ref],
    });
    expect(accepted.status).toBe(202);
    await settled(t, session.id);
    const user = provider.calls[0]?.messages.find((m) => m.role === "user");
    expect(user?.role === "user" && user.attachments).toEqual([
      {
        kind: "image",
        mimeType: "image/png",
        data: PNG.toString("base64"),
        bytes: PNG.length,
        width: 3,
        height: 2,
      },
    ]);
    const unknown = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r2",
      text: "x",
      attachments: [{ ...ref, hash: "f".repeat(64) }],
    });
    expect(unknown.status).toBe(400);
  });
});
