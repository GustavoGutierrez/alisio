import { describe, expect, it } from "vitest";
import { parseHostLine, parseHostMessage } from "../apps/desktop/src/host-protocol.ts";

describe("desktop host protocol", () => {
  it("accepts a ready message with a loopback http launch URL", () => {
    expect(
      parseHostMessage({ type: "ready", launchUrl: "http://127.0.0.1:4317/?token=abc" }),
    ).toEqual({
      type: "ready",
      launchUrl: "http://127.0.0.1:4317/?token=abc",
    });
    expect(
      parseHostMessage({ type: "ready", launchUrl: "http://localhost:1/?token=a" }),
    ).toBeDefined();
  });

  it("rejects ready messages that do not point at the local loopback server", () => {
    for (const launchUrl of [
      "https://127.0.0.1:1/?token=a",
      "http://example.com/?token=a",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "",
      42,
      undefined,
    ])
      expect(parseHostMessage({ type: "ready", launchUrl }), String(launchUrl)).toBeUndefined();
  });

  it("accepts an error message and bounds its length", () => {
    expect(parseHostMessage({ type: "error", message: "boom" })).toEqual({
      type: "error",
      message: "boom",
    });
    const long = parseHostMessage({ type: "error", message: "x".repeat(5_000) });
    expect(long?.type === "error" && long.message.length).toBe(1_000);
  });

  it("rejects unknown shapes", () => {
    for (const value of [null, undefined, 1, "ready", [], {}, { type: "other" }, { type: "error" }])
      expect(parseHostMessage(value)).toBeUndefined();
  });

  it("parses a JSON line from stdout and ignores noise", () => {
    expect(parseHostLine('{"type":"ready","launchUrl":"http://127.0.0.1:9/?token=t"}')).toEqual({
      type: "ready",
      launchUrl: "http://127.0.0.1:9/?token=t",
    });
    expect(parseHostLine("Alisio web UI: http://127.0.0.1:9")).toBeUndefined();
    expect(parseHostLine("{broken")).toBeUndefined();
  });
});
