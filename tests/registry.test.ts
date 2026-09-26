import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/core/registry.ts";

const tool = {
  name: "test",
  description: "test",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }] };
  },
};
describe("ToolRegistry", () => {
  it("rejects invalid arguments and unknown properties", () => {
    const r = new ToolRegistry();
    r.register(tool);
    expect(() => r.parse("test", '{"path":3}')).toThrow();
    expect(() => r.parse("test", '{"path":"ok","extra":true}')).toThrow();
    expect(r.parse("test", '{"path":"ok"}')).toEqual({ path: "ok" });
  });
  it("rejects duplicate tools and supports idempotent unregister", () => {
    const r = new ToolRegistry();
    const remove = r.register(tool);
    expect(() => r.register(tool)).toThrow(/Duplicate/);
    remove();
    remove();
    expect(r.list()).toHaveLength(0);
  });
  it("rejects references instead of silently degrading schemas", () => {
    const r = new ToolRegistry();
    expect(() =>
      r.register({ ...tool, inputSchema: { type: "object", $ref: "https://example.com/schema" } }),
    ).toThrow(/not supported/);
  });
});
