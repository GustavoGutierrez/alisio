import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViewContext } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { PluginHost, ViewRunError } from "../packages/core/src/plugins/host.ts";
import { ProviderRegistry } from "../packages/core/src/providers/registry.ts";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { createMemoryPlugin } from "../packages/plugin-memory/src/index.ts";
import { projectId, SQLiteMemoryStore } from "../packages/plugin-memory/src/store.ts";

interface Entry {
  id: number;
  type: string;
  title: string;
  content: string;
  contentTruncated: boolean;
  scope: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  source?: string;
  topicKey?: string;
  revisionCount: number;
  duplicateCount: number;
}
interface Page {
  items: Entry[];
  total: number;
  next?: string;
}

let root: string;
let host: PluginHost;
let tools: ToolRegistry;
const SESSION = "11111111-aaaa-bbbb-cccc-000000000001";
const OTHER = "22222222-aaaa-bbbb-cccc-000000000002";

const state = () => ({ getState: () => undefined, setState: () => {} });
const ctx = (sessionId = SESSION): ViewContext => ({
  sessionId,
  workspace: root,
  signal: new AbortController().signal,
});
/** Saves through the real `memory_save` tool, as a model in that session would. */
async function save(
  session: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const tool = tools.get("memory_save");
  await tool.execute(
    { title, type: "decision", what: `what ${title}`, ...extra },
    { signal: new AbortController().signal, workspace: root, emit: () => {}, session },
  );
}
const pin = (id: number) =>
  tools
    .get("memory_pin")
    .execute(
      { id, pinned: true },
      { signal: new AbortController().signal, workspace: root, emit: () => {} },
    );
const records = (query: Record<string, string> = {}, session = SESSION) =>
  host.runView("memory", "records", query, ctx(session)) as Promise<Page>;
/** The error a promise rejects with (fails the test when it resolves). */
const rejection = async (promise: Promise<unknown>): Promise<ViewRunError> => {
  try {
    await promise;
  } catch (error) {
    return error as ViewRunError;
  }
  throw new Error("expected the promise to reject");
};

const titles = (page: Page) => page.items.map((i) => i.title);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-memory-views-"));
  tools = new ToolRegistry();
  host = new PluginHost(tools, state(), {}, new ProviderRegistry());
  await host.activate(
    createMemoryPlugin({}, { workspace: root, stateHome: root, configDir: root }),
    root,
    { builtin: true },
  );
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("memory views: registration", () => {
  it("offers records, summary and context with declared parameters", () => {
    const views = host.viewsOf("memory");
    expect(views.map((v) => v.id)).toEqual(["context", "records", "summary"]);
    const records = views.find((v) => v.id === "records");
    expect(Object.keys((records?.params.properties ?? {}) as object).sort()).toEqual([
      "cursor",
      "limit",
      "q",
      "type",
    ]);
  });

  it("validates the type filter and the page size through the declared schema", async () => {
    await expect(records({ type: "nonsense" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(records({ limit: "0" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(records({ limit: "51" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(records({ q: "x".repeat(201) })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("memory views: saved in this chat", () => {
  it("lists only the records of the asked session and hides forgotten ones", async () => {
    await save(SESSION, "mine one");
    await save(SESSION, "mine two");
    await save(OTHER, "someone else's");
    await tools
      .get("memory_forget")
      .execute(
        { id: 2 },
        { signal: new AbortController().signal, workspace: root, emit: () => {} },
      );
    const page = await records();
    expect(titles(page)).toEqual(["mine one"]);
    expect(page.total).toBe(1);
    expect((await records({}, OTHER)).items.map((i) => i.title)).toEqual(["someone else's"]);
    expect((await records({}, "no-such-session")).items).toEqual([]);
  });

  it("describes each entry with kind, summary, timestamps and producer", async () => {
    await save(SESSION, "Use WAL", { topic_key: "architecture/sqlite-wal", scope: "personal" });
    const [entry] = (await records()).items;
    expect(entry).toMatchObject({
      type: "decision",
      title: "Use WAL",
      content: "**What**: what Use WAL",
      contentTruncated: false,
      scope: "personal",
      topicKey: "architecture/sqlite-wal",
      source: "memory_save",
      pinned: false,
      revisionCount: 1,
      duplicateCount: 1,
    });
    expect(entry?.createdAt).toBeGreaterThan(0);
    expect(entry?.updatedAt).toBeGreaterThanOrEqual(entry?.createdAt ?? 0);
  });

  it("puts pinned records first, then newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, title] of ["old", "middle", "new"].entries()) {
      vi.setSystemTime(1_000_000 + i * 1_000);
      await save(SESSION, title);
    }
    expect(titles(await records())).toEqual(["new", "middle", "old"]);
    await pin(1);
    expect(titles(await records())).toEqual(["old", "new", "middle"]);
    expect((await records()).items[0]?.pinned).toBe(true);
  });

  it("filters by type", async () => {
    await save(SESSION, "a decision");
    await save(SESSION, "a bug", { type: "bugfix" });
    expect(titles(await records({ type: "bugfix" }))).toEqual(["a bug"]);
    const page = await records({ type: "bugfix" });
    expect(page.total).toBe(1);
  });

  it("searches title, content and topic key, case-insensitively, even for short text", async () => {
    await save(SESSION, "Cache invalidation", { what: "Use a TTL of 60s" });
    await save(SESSION, "Retries", { topic_key: "config/retry-policy", what: "three tries" });
    await save(SESSION, "Zebra", { what: "100% sure about _this_" });
    await save(SESSION, "Decoy", { what: "about xthisx" });
    expect(titles(await records({ q: "cache" }))).toEqual(["Cache invalidation"]);
    expect(titles(await records({ q: "ttl" }))).toEqual(["Cache invalidation"]);
    expect(titles(await records({ q: "retry-policy" }))).toEqual(["Retries"]);
    expect(titles(await records({ q: "tt" }))).toEqual(["Cache invalidation"]);
    // LIKE wildcards in the query are literal characters.
    expect(titles(await records({ q: "100%" }))).toEqual(["Zebra"]);
    expect(titles(await records({ q: "_this_" }))).toEqual(["Zebra"]);
    expect(await records({ q: "%" })).toMatchObject({ total: 1 });
    expect((await records({ q: "nothing like this" })).items).toEqual([]);
  });

  it("paginates with a cursor: no duplicates and no gaps even when rows are added meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const original = Array.from({ length: 7 }, (_, i) => `row ${i + 1}`);
    for (const [i, title] of original.entries()) {
      vi.setSystemTime(1_000_000 + i * 1_000);
      await save(SESSION, title);
    }
    const first = await records({ limit: "3" });
    expect(first.total).toBe(7);
    expect(first.next).toBeTypeOf("string");
    // Two rows arrive while the user is browsing: they are newer, so they sort before the cursor.
    vi.setSystemTime(2_000_000);
    await save(SESSION, "late one");
    await save(SESSION, "late two");
    const seen = [...titles(first)];
    let next = first.next;
    while (next) {
      const page = await records({ limit: "3", cursor: next });
      seen.push(...titles(page));
      next = page.next;
    }
    expect(seen).toEqual([...original].reverse());
    expect(new Set(seen).size).toBe(seen.length);
    // A refresh (no cursor) shows the new rows first.
    expect(titles(await records({ limit: "3" }))).toEqual(["late two", "late one", "row 7"]);
  });

  it("keeps pinned rows first across pages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(1_000_000 + i * 1_000);
      await save(SESSION, `r${i}`);
    }
    await pin(1);
    await pin(2);
    const a = await records({ limit: "2" });
    const b = await records({ limit: "2", cursor: a.next ?? "" });
    const c = await records({ limit: "2", cursor: b.next ?? "" });
    expect([...titles(a), ...titles(b), ...titles(c)]).toEqual(["r2", "r1", "r5", "r4", "r3"]);
    expect(c.next).toBeUndefined();
  });

  it("rejects a malformed cursor as an invalid parameter", async () => {
    for (const cursor of ["not-a-cursor", "e30", Buffer.from("[1,2]").toString("base64url")]) {
      const error = await rejection(records({ cursor }));
      expect(error).toBeInstanceOf(ViewRunError);
      expect(error.code).toBe("invalid_params");
    }
  });

  it("truncates contents over the per-entry cap and says so", async () => {
    await save(SESSION, "long", { what: "w".repeat(15_000) });
    const [entry] = (await records()).items;
    expect(entry?.contentTruncated).toBe(true);
    expect(entry?.content.length).toBeLessThanOrEqual(10_000);
  });

  it("is read-only: reading changes neither access counts nor timestamps", async () => {
    await save(SESSION, "stable");
    const db = openDatabase(join(root, "memory.sqlite"));
    const snapshot = () =>
      db
        .prepare("SELECT access_count, updated_at, last_accessed_at, pinned FROM observations")
        .all();
    const before = snapshot();
    await records();
    await records({ q: "stable" });
    await host.runView("memory", "summary", {}, ctx());
    await host.runView("memory", "context", {}, ctx());
    expect(snapshot()).toEqual(before);
    db.close();
  });
});

describe("memory views: session summary", () => {
  it("is null until the plugin stored one, then returns that session's summary only", async () => {
    expect(await host.runView("memory", "summary", {}, ctx())).toEqual({ summary: null });
    const store = new SQLiteMemoryStore(openDatabase(join(root, "memory.sqlite")));
    const project = await projectId(root);
    store.saveSummary(project, SESSION, "## Goal\nShip the memory tab");
    store.saveSummary(project, OTHER, "other chat");
    store.saveSummary("another-project-00000000", "33333333", "elsewhere");
    expect(await host.runView("memory", "summary", {}, ctx())).toEqual({
      summary: {
        content: "## Goal\nShip the memory tab",
        updatedAt: expect.any(Number),
        truncated: false,
      },
    });
    expect(await host.runView("memory", "summary", {}, ctx("33333333"))).toEqual({
      summary: null,
    });
    store.close();
  });
});

describe("memory views: context loaded", () => {
  const start = (sessionId: string) =>
    host.sessionStart({ sessionId, model: "m", workspace: root });

  it("is null when nothing was injected (no memory yet, or the chat predates this feature)", async () => {
    await start(SESSION);
    expect(await host.runView("memory", "context", {}, ctx())).toEqual({ context: null });
  });

  it("returns exactly the text the plugin injected when the chat started", async () => {
    await save("earlier-chat", "Remember this");
    const { inject } = await start(SESSION);
    expect(inject).toHaveLength(1);
    const text = inject[0]?.text ?? "";
    expect(text).toContain("[Memory context from previous sessions (Alisio memory)");
    expect(await host.runView("memory", "context", {}, ctx())).toEqual({
      context: { content: text, injectedAt: expect.any(Number), truncated: false },
    });
    // Another chat never sees it.
    expect(await host.runView("memory", "context", {}, ctx(OTHER))).toEqual({ context: null });
  });

  it("keeps one record per chat (a second start replaces the first)", async () => {
    await save("earlier-chat", "First fact");
    await start(SESSION);
    await save("earlier-chat", "Second fact");
    const { inject } = await start(SESSION);
    const view = (await host.runView("memory", "context", {}, ctx())) as {
      context: { content: string };
    };
    expect(view.context.content).toBe(inject[0]?.text);
    expect(view.context.content).toContain("Second fact");
  });
});
