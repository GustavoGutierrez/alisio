/**
 * FJ-AC-23: a session saved while `execute` existed still opens after `js_run` replaced it. The
 * history is just messages; the tool name is a string, so the TUI and the web render the old call
 * as they always did (the web mapping and the TUI were left untouched), and the persisted rows
 * survive a store that now also holds Forja tables.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ToolBlock } from "../packages/cli/src/tui/components.ts";
import { itemsFromHistory } from "../packages/cli/src/tui/state.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { toolLabel, toolSummary } from "../packages/web/src/util/tools.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const history = (): Message[] => [
  { role: "user", text: "total of the three files" },
  {
    role: "assistant",
    text: "",
    calls: [{ id: "old1", name: "execute", arguments: JSON.stringify({ code: "return 1 + 1;" }) }],
  },
  {
    role: "tool",
    callId: "old1",
    result: { content: [{ type: "text", text: '{"result":2}' }] },
  } as Message,
  { role: "assistant", text: "The result is 2.", calls: [] },
];

describe("a session saved with an execute call", () => {
  it("round-trips through the store unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-legacy-execute-"));
    const store = new SQLiteStore(join(root, "sessions.sqlite"));
    cleanups.push(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const id = store.create(root, "p", "m").id;
    for (const message of history()) store.append(id, message);
    const saved = store.messages(id);
    expect(saved).toHaveLength(4);
    const call = saved.find((m) => m.role === "assistant" && m.calls.length > 0);
    expect(call?.role === "assistant" && call.calls[0]?.name).toBe("execute");
  });

  it("renders in the TUI as an ordinary tool row, without errors", () => {
    const items = itemsFromHistory(history());
    const tool = items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ name: "execute", status: "ok" });
    const lines = new ToolBlock(tool as never).render(80);
    expect(lines.join("\n")).toMatch(/execute|Execute/i);
  });

  it("renders in the web with a readable label and summary", () => {
    expect(toolLabel("execute")).toMatch(/execute/i);
    expect(toolSummary(JSON.stringify({ code: "return 1 + 1;" }))).toContain("return 1 + 1;");
  });
});
