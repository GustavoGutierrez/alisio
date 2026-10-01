/**
 * Pure logic of the web artifact panel (spec §15.2–15.4): panel width bounds and keyboard
 * resizing, the stored width (tolerant of broken storage), the exclusive right slot shared with
 * the Dock, the card subtitle, the renderer chosen per artifact and relative Markdown images.
 */
import type { ArtifactRef } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactImageUrl,
  CHAT_MIN,
  cardSubtitle,
  clampPanelWidth,
  codeLanguage,
  defaultPanelWidth,
  filterArtifacts,
  freshViewUrl,
  nextRightPanel,
  PANEL_MIN,
  panelBounds,
  rendererFor,
  resizeStep,
  storedPanelWidth,
} from "../packages/web/src/util/panel.ts";

const ref = (patch: Partial<ArtifactRef> = {}): ArtifactRef => ({
  id: "art_1",
  sessionId: "s1",
  title: "Report",
  fileName: "report.md",
  kind: "document",
  mimeType: "text/markdown; charset=utf-8",
  bytes: 10,
  fileCount: 1,
  previewable: true,
  createdAt: 1,
  status: "ready",
  ...patch,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("panel width", () => {
  it("defaults to clamp(360, 42vw, 880) and keeps the chat at least 360 px wide", () => {
    expect(defaultPanelWidth(600)).toBe(360);
    expect(defaultPanelWidth(1400)).toBe(588);
    expect(defaultPanelWidth(3000)).toBe(880);
    const bounds = panelBounds(1400, 260);
    expect(bounds).toEqual({ min: PANEL_MIN, max: 1400 - 260 - CHAT_MIN, fits: true });
    expect(clampPanelWidth(100, bounds)).toBe(320);
    expect(clampPanelWidth(5000, bounds)).toBe(780);
    expect(clampPanelWidth(500, bounds)).toBe(500);
    // Collapsing the sidebar raises the maximum; too little room means the narrow sheet.
    expect(panelBounds(1400, 56).max).toBeGreaterThan(bounds.max);
    expect(panelBounds(900, 260).fits).toBe(false);
  });

  it("moves the handle with the keyboard: ±16 px, ±64 px with Shift, Home/End, Enter resets", () => {
    const bounds = panelBounds(1400, 260);
    const base = { width: 500, bounds, reset: 588 };
    // The handle sits left of the panel: ← widens the panel, → narrows it.
    expect(resizeStep({ ...base, key: "ArrowLeft", shift: false })).toBe(516);
    expect(resizeStep({ ...base, key: "ArrowRight", shift: false })).toBe(484);
    expect(resizeStep({ ...base, key: "ArrowLeft", shift: true })).toBe(564);
    expect(resizeStep({ ...base, key: "ArrowRight", shift: true })).toBe(436);
    expect(resizeStep({ ...base, key: "Home", shift: false })).toBe(320);
    expect(resizeStep({ ...base, key: "End", shift: false })).toBe(780);
    expect(resizeStep({ ...base, key: "Enter", shift: false })).toBe(588);
    expect(resizeStep({ ...base, width: 330, key: "ArrowRight", shift: true })).toBe(320);
    expect(resizeStep({ ...base, key: "a", shift: false })).toBeUndefined();
  });

  it("reads the stored width defensively: garbage or throwing storage falls back to the default", () => {
    expect(storedPanelWidth(() => "512")).toBe(512);
    expect(storedPanelWidth(() => "wide")).toBeUndefined();
    expect(storedPanelWidth(() => "-4")).toBeUndefined();
    expect(storedPanelWidth(() => undefined)).toBeUndefined();
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("SecurityError");
      },
    });
    // The real reader (readPref) swallows the exception: the panel uses its default width.
    expect(storedPanelWidth()).toBeUndefined();
  });
});

describe("right slot", () => {
  it("is exclusive: opening the artifact panel closes the Dock and vice versa", () => {
    expect(nextRightPanel({ dock: true, artifact: undefined }, { artifact: "a1" })).toEqual({
      dock: false,
      artifact: "a1",
    });
    expect(nextRightPanel({ dock: false, artifact: "a1" }, { dock: true })).toEqual({
      dock: true,
      artifact: undefined,
    });
    expect(nextRightPanel({ dock: false, artifact: "a1" }, { artifact: undefined })).toEqual({
      dock: false,
      artifact: undefined,
    });
  });
});

describe("artifact card", () => {
  it("shows the kind label at rest and 'Open file' on hover/focus only when previewable", () => {
    expect(cardSubtitle(ref(), "ready")).toEqual({ rest: "kind", hover: true, partial: false });
    expect(cardSubtitle(ref({ partial: true }), "ready")).toMatchObject({ partial: true });
    expect(cardSubtitle(ref({ kind: "archive", previewable: false }), "ready").hover).toBe(false);
    expect(cardSubtitle(ref({ fileName: "a.docx", previewable: false }), "ready").hover).toBe(
      false,
    );
    expect(cardSubtitle(ref(), "loading")).toEqual({
      rest: "loading",
      hover: false,
      partial: false,
    });
    expect(cardSubtitle(ref(), "deleted").rest).toBe("deleted");
    expect(cardSubtitle(ref(), "expired").rest).toBe("expired");
    expect(cardSubtitle(ref(), "ready", "boom").rest).toBe("error");
  });
});

describe("renderers", () => {
  it("picks one renderer per kind and falls back with a reason", () => {
    expect(rendererFor(ref())).toEqual({ kind: "markdown" });
    expect(rendererFor(ref({ kind: "dashboard", fileName: "s.html" }))).toEqual({ kind: "html" });
    expect(
      rendererFor(ref({ kind: "document", fileName: "a.pdf", mimeType: "application/pdf" })),
    ).toEqual({ kind: "pdf" });
    expect(rendererFor(ref({ kind: "image", fileName: "c.svg" }))).toEqual({ kind: "image" });
    expect(rendererFor(ref({ kind: "data", fileName: "d.json" }))).toEqual({ kind: "json" });
    expect(rendererFor(ref({ kind: "spreadsheet", fileName: "t.csv" }))).toEqual({
      kind: "spreadsheet",
    });
    expect(rendererFor(ref({ kind: "spreadsheet", fileName: "book.xlsx" }))).toEqual({
      kind: "spreadsheet",
    });
    expect(rendererFor(ref({ kind: "code", fileName: "x.py" }))).toEqual({ kind: "code" });
    expect(rendererFor(ref({ kind: "archive", fileName: "a.zip", previewable: false }))).toEqual({
      kind: "fallback",
      reason: "noPreview",
    });
    expect(rendererFor(ref({ bytes: 3 * 1024 * 1024, previewable: false }))).toEqual({
      kind: "fallback",
      reason: "tooLarge",
    });
    expect(codeLanguage("main.py")).toBe("python");
    expect(codeLanguage("table.csv")).toBe("csv");
    expect(codeLanguage("notes")).toBeUndefined();
  });

  it("rewrites relative Markdown images into the artifact and refuses escapes", () => {
    expect(artifactImageUrl("chart.svg", "art_1", "report.md")).toBe(
      "/api/artifacts/art_1/files/chart.svg",
    );
    expect(artifactImageUrl("img/a b.png", "art_1", "docs/report.md")).toBe(
      "/api/artifacts/art_1/files/docs/img/a%20b.png",
    );
    expect(artifactImageUrl("./x.png", "art_1", "report.md")).toBe(
      "/api/artifacts/art_1/files/x.png",
    );
    for (const href of ["../x.png", "/etc/x.png", "https://cdn/x.png", "data:x", "//h/x.png"])
      expect(artifactImageUrl(href, "art_1", "report.md"), href).toBeUndefined();
  });
});

describe("artifact switcher", () => {
  it("filters by name, title and kind; caches view links until 30 s before expiry", () => {
    const list = [
      ref({ id: "a", fileName: "sales.html", title: "Sales", kind: "dashboard" }),
      ref({ id: "b", fileName: "notes.md", title: "Notes" }),
    ];
    expect(filterArtifacts(list, "").map((a) => a.id)).toEqual(["a", "b"]);
    expect(filterArtifacts(list, "dash").map((a) => a.id)).toEqual(["a"]);
    expect(filterArtifacts(list, "NOTES").map((a) => a.id)).toEqual(["b"]);
    expect(freshViewUrl({ url: "/v", expiresAt: 100_000 }, 60_000)).toBe("/v");
    expect(freshViewUrl({ url: "/v", expiresAt: 100_000 }, 70_001)).toBeUndefined();
    expect(freshViewUrl(undefined, 0)).toBeUndefined();
  });
});
