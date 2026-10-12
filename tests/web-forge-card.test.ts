/**
 * The tool cards of Forja (Forja spec §11.2, Python spec §9.4): which cards exist, the engine and
 * isolation badge (text and icon, never colour alone), what the `js_run` result text means,
 * what a `python_run` card learns about its engine, and the provenance rows of an artifact.
 * Legacy `execute` calls from old sessions keep the generic card (FJ-AC-23).
 */
import type { Message, ServerFrame, SessionDetailWire } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLocale, setLocale, t } from "../packages/web/src/i18n/index.ts";
import { applyFrame, emptyTranscript, visibleItems } from "../packages/web/src/store/transcript.ts";
import {
  cardKind,
  codeOf,
  engineBadge,
  engineOfCard,
  liveAnnouncement,
  parseEngineLine,
  parseJsResult,
  provenanceEngine,
} from "../packages/web/src/util/forge-card.ts";

afterEach(() => vi.unstubAllGlobals());

const SID = "s1";
const session: SessionDetailWire = {
  id: SID,
  workspaceId: "w1",
  workspace: "/ws",
  provider: "fake",
  model: "m",
  status: "idle",
};
const snapshot = (items: Array<{ seq: number; message: Message }>): ServerFrame => ({
  t: "snapshot",
  sessionId: SID,
  cursor: 1,
  session,
  messages: { items: items.map((i) => ({ ...i, compacted: false })), hasMore: false },
  pending: { approvals: [], interactions: [] },
});

describe("which card a tool call gets", () => {
  it("gives js_run and python_run their cards and everything else the generic one", () => {
    expect(cardKind("js_run")).toBe("javascript");
    expect(cardKind("python_run")).toBe("python");
    for (const name of ["execute", "read_file", "p_0123456789_js_run", "forge_guide"])
      expect(cardKind(name), name).toBe("generic");
  });

  it("renders a persisted session with legacy `execute` calls as ordinary rows (FJ-AC-23)", () => {
    const state = applyFrame(
      emptyTranscript(SID),
      snapshot([
        { seq: 1, message: { role: "user", text: "old session" } },
        {
          seq: 2,
          message: {
            role: "assistant",
            text: "",
            calls: [{ id: "e1", name: "execute", arguments: '{"code":"return 1"}' }],
          },
        },
        {
          seq: 3,
          message: {
            role: "tool",
            callId: "e1",
            result: { content: [{ type: "text", text: "1" }] },
          },
        },
        { seq: 4, message: { role: "assistant", text: "done", calls: [] } },
      ]),
    );
    const rows = visibleItems(state).flatMap((item) => (item.kind === "tool" ? [item.tool] : []));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "execute", status: "completed" });
    expect(cardKind(rows[0]?.name ?? "")).toBe("generic");
  });
});

describe("engine badge", () => {
  it("states engine and isolation in words, with an icon, and warns on the host", async () => {
    vi.stubGlobal("document", { documentElement: {} });
    await setLocale("en");
    const badge = (engine: Parameters<typeof engineBadge>[0], isolation?: string) =>
      engineBadge(engine, isolation as never);
    expect(t(badge("javascript-quickjs").label)).toBe("JavaScript · WASM isolate");
    expect(t(badge("python-oci").label)).toBe("Python · OCI container");
    expect(t(badge("python-wasm").label)).toBe("Python · WASM process");
    expect(t(badge("python-managed").label)).toBe("Python · host (not sandboxed)");
    expect(badge("python-managed")).toMatchObject({ tone: "warn", sandboxed: false });
    expect(badge("python-oci")).toMatchObject({ tone: "ok", sandboxed: true });
    // The icon differs between the sandboxed and the unprotected cases: colour is never the only cue.
    expect(badge("python-managed").icon).not.toBe(badge("python-oci").icon);
  });

  it("trusts the reported isolation over the engine's usual one", () => {
    expect(engineBadge("python-wasm", "none")).toMatchObject({ tone: "warn", sandboxed: false });
    expect(engineBadge("python-managed", "os-container").sandboxed).toBe(true);
  });

  it("has Spanish text for every badge", async () => {
    vi.stubGlobal("document", { documentElement: {} });
    await loadLocale("es");
    await setLocale("es");
    expect(t(engineBadge("python-managed").label)).toBe("Python · host (sin aislamiento)");
    expect(t(engineBadge("javascript-quickjs").label)).toBe("JavaScript · aislado en WASM");
    await setLocale("en");
  });
});

describe("python_run engine line", () => {
  const text = `ok in 3s\nengine: python-wasm (wasm-process) · reason: auto: oci is not ready; wasm is`;
  it("reads engine, isolation and the selection reason from the result text", () => {
    expect(parseEngineLine(text)).toEqual({
      engine: "python-wasm",
      isolation: "wasm-process",
      reason: "auto: oci is not ready; wasm is",
    });
    expect(parseEngineLine("no such line")).toBeUndefined();
    expect(parseEngineLine("engine: bogus (none) · reason: x")).toBeUndefined();
  });

  it("falls back from the result to the live progress to nothing", () => {
    expect(engineOfCard({ resultText: text })).toEqual({
      engine: "python-wasm",
      isolation: "wasm-process",
      reason: "auto: oci is not ready; wasm is",
    });
    expect(engineOfCard({ forgeEngine: "python-oci" })).toEqual({ engine: "python-oci" });
    expect(engineOfCard({})).toBeUndefined();
  });
});

describe("js_run result", () => {
  it("reads a successful run: value, emitted output and nested call counters", () => {
    const parsed = parseJsResult(
      [
        "status: succeeded",
        'value: {"files":3}',
        "output:\nline one\ncalls: not a counter\nline two",
        "calls: 4 total, 1 failed, 0 denied",
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      status: "succeeded",
      value: { files: 3 },
      output: "line one\ncalls: not a counter\nline two",
      calls: { total: 4, failed: 1, denied: 0 },
      truncated: false,
    });
    expect(parsed?.error).toBeUndefined();
  });

  it("reads the error and its hint, and the truncation note", () => {
    const parsed = parseJsResult(
      [
        "status: failed",
        "[output truncated at 16000 characters; return less: filter, aggregate or paginate]",
        "calls: 0 total, 0 failed, 0 denied",
        "error: SCRIPT_SYNTAX: unexpected token 'import'",
        'hint: imports are not available (forge_guide topic "js.api")',
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      status: "failed",
      truncated: true,
      error: { code: "SCRIPT_SYNTAX", message: "unexpected token 'import'" },
      hint: 'imports are not available (forge_guide topic "js.api")',
    });
  });

  it("shows a refused call (no status line) as an error, and text that is not a report as nothing", () => {
    expect(parseJsResult("INVALID_INPUT: pass exactly one of `code` or `codePath`")).toMatchObject({
      status: "failed",
      error: { code: "INVALID_INPUT", message: "pass exactly one of `code` or `codePath`" },
    });
    expect(parseJsResult("hello")).toBeUndefined();
  });

  it("keeps a multi-line error message together", () => {
    const parsed = parseJsResult(
      "status: failed\ncalls: 1 total, 1 failed, 0 denied\nerror: SCRIPT_RUNTIME: boom\n  at line 2",
    );
    expect(parsed?.error?.message).toBe("boom\n  at line 2");
  });
});

describe("js_run input", () => {
  it("takes the code, the scratchpad path and the title from the arguments", () => {
    expect(codeOf('{"code":"return 1","title":"One"}')).toEqual({ code: "return 1", title: "One" });
    expect(codeOf('{"codePath":"work/a.js"}')).toEqual({ codePath: "work/a.js" });
    expect(codeOf("{broken")).toEqual({});
  });
});

describe("artifact provenance rows", () => {
  it("lists engine, isolation, reason, and the wasm startup and memory", () => {
    expect(
      provenanceEngine({
        engine: "python-wasm",
        isolation: "wasm-process",
        selectionReason: "auto: wasm",
        runtime: { mode: "wasm", startupMs: 1850, peakRssMb: 212 },
      }),
    ).toEqual({
      engine: "python-wasm",
      isolation: "wasm-process",
      reason: "auto: wasm",
      startupMs: 1850,
      peakRssMb: 212,
    });
  });

  it("leaves old artifacts, with none of these fields, without the rows", () => {
    expect(provenanceEngine({ runtime: { mode: "managed" } })).toBeUndefined();
    expect(provenanceEngine({ engine: "python-oci" })).toEqual({ engine: "python-oci" });
  });
});

describe("screen reader announcements", () => {
  const view = {
    executionId: "e1",
    engine: "javascript-quickjs" as const,
    phase: "call" as const,
    calls: [
      { callId: 1, tool: "list_files", status: "succeeded" as const, durationMs: 4 },
      { callId: 2, tool: "read_file", status: "started" as const },
    ],
  };

  it("announces the state of the card, not every progress tick", async () => {
    vi.stubGlobal("document", { documentElement: {} });
    await setLocale("en");
    expect(liveAnnouncement("running", view)).toBe("Running: 1 of 2 calls finished");
    expect(liveAnnouncement("running", undefined)).toBe("Running");
    expect(liveAnnouncement("completed", view)).toBe("Finished");
    expect(liveAnnouncement("failed", view)).toBe("Failed");
    expect(liveAnnouncement("pending", undefined)).toBe("");
    // The same text for the same state: a re-render with new timings says nothing new.
    expect(liveAnnouncement("running", { ...view, message: "Reading" })).toBe(
      liveAnnouncement("running", view),
    );
  });
});
