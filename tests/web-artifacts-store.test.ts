import type { ArtifactRef, ServerFrame, ToolResult } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  applyFrames,
  emptyTranscript,
  visibleItems,
} from "../packages/web/src/store/transcript.ts";
import {
  artifactsOfResult,
  downloadUrl,
  mergeArtifacts,
  primaryAction,
  reconcile,
  showsOpenFile,
} from "../packages/web/src/util/artifacts.ts";

const ref = (id: string, patch: Partial<ArtifactRef> = {}): ArtifactRef => ({
  id,
  sessionId: "s1",
  title: id,
  fileName: `${id}.md`,
  kind: "document",
  mimeType: "text/markdown; charset=utf-8",
  bytes: 10,
  fileCount: 1,
  previewable: true,
  createdAt: 1,
  status: "ready",
  ...patch,
});
const result = (...artifacts: ArtifactRef[]): ToolResult => ({
  content: [
    { type: "text", text: "published" },
    { type: "ui", block: { kind: "terminal", output: "" } },
    ...artifacts.map((artifact) => ({
      type: "ui" as const,
      block: { kind: "artifact" as const, artifact },
    })),
  ],
});

describe("artifact cards: data and reconciliation", () => {
  it("reads the artifacts a tool result announced, in order", () => {
    expect(artifactsOfResult(result(ref("a"), ref("b"))).map((a) => a.id)).toEqual(["a", "b"]);
    expect(artifactsOfResult(undefined)).toEqual([]);
  });

  it("is loading until the session list arrives, then follows the list by id", () => {
    const card = ref("a");
    expect(reconcile(card, undefined)).toEqual({ artifact: card, state: "loading" });
    expect(reconcile(card, [ref("a", { status: "deleted" })]).state).toBe("deleted");
    expect(reconcile(card, [ref("a", { status: "expired" })]).state).toBe("expired");
    // Not in the (paged) list: the card keeps its own data.
    expect(reconcile(card, [ref("z")])).toEqual({ artifact: card, state: "ready" });
  });

  it("merges published artifacts once per id, newest first", () => {
    const merged = mergeArtifacts(
      [ref("old", { createdAt: 1 })],
      [ref("new", { createdAt: 5 }), ref("old", { createdAt: 1, status: "deleted" })],
    );
    expect(merged.map((a) => [a.id, a.status])).toEqual([
      ["new", "ready"],
      ["old", "deleted"],
    ]);
  });

  it("phase 2: previewable artifacts open the panel; the rest download and never say 'Open file'", () => {
    expect(primaryAction(ref("md"))).toBe("open");
    expect(showsOpenFile(ref("md"))).toBe(true);
    for (const artifact of [
      ref("zip", { kind: "archive", previewable: false }),
      ref("docx", { previewable: false }),
      ref("gone", { status: "deleted" }),
    ]) {
      expect(primaryAction(artifact)).toBe("download");
      expect(showsOpenFile(artifact)).toBe(false);
    }
    expect(downloadUrl("art_1/x")).toBe("/api/artifacts/art_1%2Fx/download");
  });
});

describe("artifact cards: placement in the transcript", () => {
  it("puts one card group right after the tool rows of the turn that published them", () => {
    const frames: ServerFrame[] = [
      {
        t: "snapshot",
        sessionId: "s1",
        cursor: 0,
        session: {
          id: "s1",
          workspaceId: "w",
          workspace: "/w",
          provider: "p",
          model: "m",
          status: "idle",
        },
        messages: {
          hasMore: false,
          items: [
            { seq: 1, compacted: false, message: { role: "user", text: "analyze" } },
            {
              seq: 2,
              compacted: false,
              message: {
                role: "assistant",
                text: "",
                calls: [{ id: "c1", name: "python_run", arguments: "{}" }],
              },
            },
            {
              seq: 3,
              compacted: false,
              message: { role: "tool", callId: "c1", result: result(ref("a"), ref("b")) },
            },
            {
              seq: 4,
              compacted: false,
              message: { role: "assistant", text: "Here you go", calls: [] },
            },
          ],
        },
        pending: { approvals: [], interactions: [] },
      },
    ];
    const items = visibleItems(applyFrames(emptyTranscript("s1"), frames));
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "artifacts", "assistant"]);
    const cards = items[2] as Extract<(typeof items)[number], { kind: "artifacts" }>;
    expect(cards.artifacts.map((a) => a.id)).toEqual(["a", "b"]);
  });
});
