import { describe, expect, it } from "vitest";
import {
  type EngineCandidate,
  selectDocumentEngine,
} from "../packages/core/src/documents/engine-select.ts";

const ready = (id: EngineCandidate["id"]): EngineCandidate => ({
  id,
  readiness: { ready: true, version: "1" },
});
const down = (id: EngineCandidate["id"]): EngineCandidate => ({
  id,
  readiness: { ready: false, reason: `${id} down`, fix: `fix ${id}` },
});
const pick = (over: Partial<Parameters<typeof selectDocumentEngine>[0]>) =>
  selectDocumentEngine({ configured: "auto", candidates: [], quality: "professional", ...over });

describe("selectDocumentEngine (DOC-AC-09)", () => {
  it("auto prefers electron, then chromium, then weasyprint", () => {
    expect(pick({ candidates: [ready("electron"), ready("chromium")] })).toEqual({
      ok: true,
      engine: "electron",
    });
    expect(
      pick({ candidates: [down("electron"), ready("chromium"), ready("weasyprint")] }),
    ).toEqual({ ok: true, engine: "chromium" });
    expect(pick({ candidates: [down("chromium"), ready("weasyprint")] })).toEqual({
      ok: true,
      engine: "weasyprint",
    });
  });

  it("uses weasyprint first only for a WeasyPrint-only feature at professional quality", () => {
    const candidates = [ready("chromium"), ready("weasyprint")];
    expect(pick({ candidates, needsWeasyprintOnly: true })).toEqual({
      ok: true,
      engine: "weasyprint",
    });
    expect(pick({ candidates, needsWeasyprintOnly: true, quality: "fast" })).toEqual({
      ok: true,
      engine: "chromium",
    });
    expect(
      pick({ candidates: [ready("chromium"), down("weasyprint")], needsWeasyprintOnly: true }),
    ).toEqual({ ok: true, engine: "chromium" });
  });

  it("honors an explicit engine or fails with its reason and fix, never switching silently", () => {
    expect(
      pick({ configured: "weasyprint", candidates: [ready("chromium"), down("weasyprint")] }),
    ).toEqual({
      ok: false,
      reasons: [{ engine: "weasyprint", reason: "weasyprint down", fix: "fix weasyprint" }],
    });
    expect(
      pick({
        configured: "weasyprint",
        requested: "chromium",
        candidates: [ready("chromium"), down("weasyprint")],
      }),
    ).toEqual({ ok: true, engine: "chromium" });
    expect(
      pick({ configured: "chromium", candidates: [ready("electron"), down("chromium")] }),
    ).toEqual({ ok: true, engine: "electron" });
  });

  it("lists every reason and fix when nothing is ready", () => {
    const result = pick({ candidates: [down("chromium"), down("weasyprint")] });
    expect(result).toEqual({
      ok: false,
      reasons: [
        { engine: "chromium", reason: "chromium down", fix: "fix chromium" },
        { engine: "weasyprint", reason: "weasyprint down", fix: "fix weasyprint" },
      ],
    });
  });
});
