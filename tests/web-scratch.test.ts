/**
 * The Scratch tab (Forja spec §11.2, FJ-AC-35): the API calls, the pure helpers (preview kind,
 * download URL, quota bar, order) and the store driven through a fake API: list, select, empty
 * with its three outcomes (done, a run is active, read-only), stale answers and an unavailable
 * scratchpad. No editing exists anywhere in the module.
 */
import { readFileSync } from "node:fs";
import type { ScratchListing } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchStrings } from "../packages/web/src/components/dock/scratch-strings.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { ApiClient, ApiRequestError } from "../packages/web/src/net/api.ts";
import { api } from "../packages/web/src/store/app.ts";
import {
  clearScratch,
  loadScratch,
  resetScratch,
  scratchState,
  selectScratchFile,
} from "../packages/web/src/store/scratch.ts";
import {
  newestFirst,
  previewOf,
  quotaLevel,
  scratchFileUrl,
} from "../packages/web/src/util/scratch.ts";

const file = (name: string, size = 10, mtime = 1) => ({ name, size, mtime });
const listing = (patch: Partial<ScratchListing> = {}): ScratchListing => ({
  available: true,
  files: [file("a.js", 100, 1), file("out/report.md", 2000, 3), file("data.csv", 50, 2)],
  usedBytes: 2150,
  quotaBytes: 10_000,
  ...patch,
});

describe("scratch API calls", () => {
  it("lists with GET and empties with DELETE on the session's scratch route", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const client = new ApiClient({
      fetch: async (url, init) => {
        calls.push({ url, ...(init.method ? { method: init.method } : {}) });
        return new Response(
          JSON.stringify({ available: false, files: [], usedBytes: 0, quotaBytes: 1 }),
          {
            status: 200,
          },
        );
      },
    });
    await client.scratch("s 1");
    await client.clearScratch("s 1");
    expect(calls).toEqual([
      { url: "/api/sessions/s%201/scratch", method: "GET" },
      { url: "/api/sessions/s%201/scratch", method: "DELETE" },
    ]);
  });

  it("reads the Forja overview of a workspace", async () => {
    let seen = "";
    const client = new ApiClient({
      fetch: async (url) => {
        seen = url;
        return new Response("{}", { status: 200 });
      },
    });
    await client.forge("w 1");
    expect(seen).toBe("/api/forge?workspace=w%201");
  });
});

describe("scratch helpers", () => {
  it("previews only text and code the viewers know, and nothing large", () => {
    expect(previewOf(file("a.js"))).toEqual({ as: "code", entry: "a.js" });
    expect(previewOf(file("x/y.py"))).toEqual({ as: "code", entry: "x/y.py" });
    expect(previewOf(file("t.csv"))).toEqual({ as: "code", entry: "t.csv" });
    expect(previewOf(file("n.txt"))).toEqual({ as: "code", entry: "n.txt" });
    expect(previewOf(file("d.json"))).toEqual({ as: "json", entry: "d.json" });
    expect(previewOf(file("r.md"))).toEqual({ as: "markdown", entry: "r.md" });
    expect(previewOf(file("PIC.PNG"))).toBeUndefined();
    expect(previewOf(file("noext"))).toBeUndefined();
    expect(previewOf(file("big.json", 3 * 1024 * 1024))).toBeUndefined();
  });

  it("builds a download URL from relative names only", () => {
    expect(scratchFileUrl("s1", "out/my report.md")).toBe(
      "/api/sessions/s1/scratch/files/out/my%20report.md",
    );
    expect(scratchFileUrl("s/1", "a.js")).toBe("/api/sessions/s%2F1/scratch/files/a.js");
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "C:\\x", "a\\b", ""])
      expect(scratchFileUrl("s1", bad), bad).toBeUndefined();
  });

  it("orders newest first, then by name, without touching the input", () => {
    const input = [file("b", 1, 5), file("a", 1, 5), file("c", 1, 9)];
    expect(newestFirst(input).map((f) => f.name)).toEqual(["c", "a", "b"]);
    expect(input.map((f) => f.name)).toEqual(["b", "a", "c"]);
  });

  it("grades the quota bar and caps it at 100 %", () => {
    expect(quotaLevel(0, 100)).toEqual({ percent: 0, level: "ok" });
    expect(quotaLevel(79, 100)).toEqual({ percent: 79, level: "ok" });
    expect(quotaLevel(80, 100)).toEqual({ percent: 80, level: "warn" });
    expect(quotaLevel(95, 100)).toEqual({ percent: 95, level: "full" });
    expect(quotaLevel(500, 100)).toEqual({ percent: 100, level: "full" });
    expect(quotaLevel(5, 0)).toEqual({ percent: 0, level: "ok" });
  });
});

describe("scratch store", () => {
  beforeEach(() => resetScratch());
  afterEach(() => vi.restoreAllMocks());

  it("loads the listing of a session, then stays idle for no session", async () => {
    vi.spyOn(api, "scratch").mockResolvedValue(listing());
    expect(scratchState.value.status).toBe("idle");
    await loadScratch("s1");
    expect(scratchState.value).toMatchObject({ sessionId: "s1", status: "ready" });
    expect(scratchState.value.listing?.files).toHaveLength(3);
  });

  it("reports an unavailable scratchpad as ready-but-off, not as an error", async () => {
    vi.spyOn(api, "scratch").mockResolvedValue(
      listing({ available: false, files: [], usedBytes: 0 }),
    );
    await loadScratch("s1");
    expect(scratchState.value).toMatchObject({ status: "ready", listing: { available: false } });
  });

  it("keeps the failure message and no stale listing when a load fails", async () => {
    vi.spyOn(api, "scratch").mockRejectedValue(new ApiRequestError(500, "internal", "boom"));
    await loadScratch("s1");
    expect(scratchState.value).toMatchObject({ status: "error", error: "boom" });
    expect(scratchState.value.listing).toBeUndefined();
  });

  it("drops the answer of a session the tab has already left", async () => {
    let release: (value: ScratchListing) => void = () => undefined;
    vi.spyOn(api, "scratch").mockImplementation(
      (sid) =>
        new Promise((resolve) => {
          if (sid === "old") release = resolve;
          else resolve(listing({ files: [file("new.js")] }));
        }),
    );
    const first = loadScratch("old");
    await loadScratch("new");
    release(listing({ files: [file("old.js")] }));
    await first;
    expect(scratchState.value.sessionId).toBe("new");
    expect(scratchState.value.listing?.files.map((f) => f.name)).toEqual(["new.js"]);
  });

  it("selects a listed file and forgets the selection when the file disappears", async () => {
    const scratch = vi.spyOn(api, "scratch").mockResolvedValue(listing());
    await loadScratch("s1");
    selectScratchFile("a.js");
    expect(scratchState.value.selected).toBe("a.js");
    selectScratchFile("nope.js");
    expect(scratchState.value.selected).toBe("a.js");
    scratch.mockResolvedValue(listing({ files: [file("data.csv")] }));
    await loadScratch("s1");
    expect(scratchState.value.selected).toBeUndefined();
  });

  it("empties the scratchpad and says how much went", async () => {
    vi.spyOn(api, "scratch").mockResolvedValue(listing());
    const clear = vi.spyOn(api, "clearScratch").mockResolvedValue({ removed: 3, freedBytes: 2150 });
    await loadScratch("s1");
    selectScratchFile("a.js");
    await clearScratch("s1");
    expect(clear).toHaveBeenCalledWith("s1");
    expect(scratchState.value).toMatchObject({
      clearing: false,
      listing: { files: [], usedBytes: 0, quotaBytes: 10_000 },
      notice: { kind: "cleared", removed: 3, freedBytes: 2150 },
    });
    expect(scratchState.value.selected).toBeUndefined();
  });

  it("explains a refused emptying and keeps the files: a run is active, or read-only", async () => {
    vi.spyOn(api, "scratch").mockResolvedValue(listing());
    const clear = vi
      .spyOn(api, "clearScratch")
      .mockRejectedValue(new ApiRequestError(409, "runs_active", "A run is active"));
    await loadScratch("s1");
    await clearScratch("s1");
    expect(scratchState.value.notice).toEqual({ kind: "runsActive" });
    expect(scratchState.value.listing?.files).toHaveLength(3);
    clear.mockRejectedValue(new ApiRequestError(403, "capability_ceiling", "read-only"));
    await clearScratch("s1");
    expect(scratchState.value.notice).toEqual({ kind: "readOnly" });
    clear.mockRejectedValue(new ApiRequestError(500, "internal", "disk failure"));
    await clearScratch("s1");
    expect(scratchState.value.notice).toEqual({ kind: "failed", message: "disk failure" });
    expect(scratchState.value.listing?.files).toHaveLength(3);
  });
});

describe("strings and loading", () => {
  it("has every Scratch string in English and Spanish, translated", () => {
    const keys = Object.keys(scratchStrings.en) as Array<keyof typeof scratchStrings.en>;
    for (const required of ["unavailable", "runsActive", "confirm", "cleared", "noPreview"])
      expect(keys, required).toContain(required);
    expect(Object.keys(scratchStrings.es).sort()).toEqual([...keys].sort());
    // The name of the feature is the same word in both languages (as in the specification).
    const same = ["title"];
    for (const key of keys) {
      expect(scratchStrings.en[key], `en ${key}`).toBeTruthy();
      expect(scratchStrings.es[key], `es ${key}`).toBeTruthy();
      if (!same.includes(key))
        expect(scratchStrings.es[key], `es differs ${key}`).not.toBe(scratchStrings.en[key]);
    }
    expect(en["dock.scratch"]).toBe("Scratch");
    expect(es["dock.scratch"]).toBeTruthy();
  });

  it("adds the tab to the dock as its own chunk, outside the initial bundle", () => {
    const dock = readFileSync("packages/web/src/components/dock/Dock.tsx", "utf8");
    expect(dock).toMatch(/const TABS: DockTab\[\] = \[[^\]]*"scratch"/);
    expect(dock).not.toMatch(/^import .*ScratchTab/m);
    expect(dock).toMatch(/import\("\.\/ScratchTab\.tsx"\)/);
  });
});
