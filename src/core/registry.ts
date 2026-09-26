import type { ToolDefinition } from "@alisio/sdk";
import Ajv, { type ValidateFunction } from "ajv";

import Ajv2020 from "ajv/dist/2020.js";

const ajv2020 = new Ajv2020({ allErrors: true, strict: true });
const ajv = new Ajv({ allErrors: true, strict: true });
function rejectReferences(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (["$ref", "$id", "$async"].includes(k))
      throw new Error(`Schema keyword ${k} is not supported`);
    rejectReferences(v);
  }
}
export class ToolRegistry {
  private entries = new Map<string, { tool: ToolDefinition; validate: ValidateFunction }>();
  register(tool: ToolDefinition): () => void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name))
      throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.entries.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    if (tool.inputSchema.type !== "object") throw new Error("Tool input schema must be an object");
    rejectReferences(tool.inputSchema);
    const entry = {
      tool,
      validate: (tool.inputSchema.$schema === "https://json-schema.org/draft/2020-12/schema"
        ? ajv2020
        : ajv
      ).compile(tool.inputSchema),
    };
    this.entries.set(tool.name, entry);
    return () => {
      if (this.entries.get(tool.name) === entry) this.entries.delete(tool.name);
    };
  }
  list(): ToolDefinition[] {
    return [...this.entries.values()].map((x) => x.tool);
  }
  get(name: string): ToolDefinition {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Unknown tool: ${name}`);
    return e.tool;
  }
  parse(name: string, argumentsText: string): Record<string, unknown> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Unknown tool: ${name}`);
    const value: unknown = JSON.parse(argumentsText);
    if (!e.validate(value)) throw new Error(ajv.errorsText(e.validate.errors));
    return value as Record<string, unknown>;
  }
}
