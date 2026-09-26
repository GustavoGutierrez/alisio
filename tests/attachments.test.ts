import { describe, expect, it } from "vitest";
import {
  type AttachmentRejection,
  addAttachment,
  attachmentCaption,
  buildAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  type PendingAttachment,
  pasteImageFromClipboard,
  rejectionMessage,
  removeLastAttachment,
  sniffImageMime,
  toApiAttachment,
} from "../packages/cli/src/tui/attachments.ts";

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_SIG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF_SIG = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_SIG = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const junk = Uint8Array.from([1, 2, 3, 4]);
let n = 0;
const ids = () => `id${++n}`;

describe("image sniffing", () => {
  it("recognizes PNG, JPEG, GIF and WebP by magic bytes, else undefined", () => {
    expect(sniffImageMime(PNG_SIG)).toBe("image/png");
    expect(sniffImageMime(JPEG_SIG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF_SIG)).toBe("image/gif");
    expect(sniffImageMime(WEBP_SIG)).toBe("image/webp");
    expect(sniffImageMime(junk)).toBeUndefined();
    expect(sniffImageMime(new Uint8Array(0))).toBeUndefined();
  });
});

describe("buildAttachment", () => {
  it("builds a base64 attachment with detected dimensions", () => {
    const result = buildAttachment(PNG_SIG, {
      id: ids,
      dimensions: () => ({ widthPx: 10, heightPx: 20 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.attachment).toMatchObject({
      mimeType: "image/png",
      bytes: PNG_SIG.length,
      width: 10,
      height: 20,
    });
    expect(result.attachment.data).toBe(Buffer.from(PNG_SIG).toString("base64"));
    expect(result.attachment.id).toBe("id1");
  });

  it("omits dimensions when they cannot be determined", () => {
    const result = buildAttachment(PNG_SIG, { id: ids, dimensions: () => null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.attachment.width).toBeUndefined();
    expect(result.attachment.height).toBeUndefined();
  });

  it("rejects empty, unsupported and oversized input", () => {
    expect(buildAttachment(new Uint8Array(0), { id: ids })).toEqual({ ok: false, error: "empty" });
    expect(buildAttachment(junk, { id: ids })).toEqual({ ok: false, error: "unsupported-format" });
    const big = new Uint8Array(20);
    big.set(PNG_SIG);
    expect(buildAttachment(big, { id: ids, maxBytes: 10 })).toEqual({
      ok: false,
      error: "too-large",
    });
  });

  it("defaults the size cap to 5 MB", () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(4);
  });
});

describe("pending list operations", () => {
  const list = (n: number): PendingAttachment[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      mimeType: "image/png",
      data: "AAAA",
      bytes: 4,
    }));

  it("appends within the count limit and rejects beyond it", () => {
    const under = addAttachment(list(1), PNG_SIG, { id: ids, maxCount: 4 });
    expect(under.list).toHaveLength(2);
    expect(under.error).toBeUndefined();
    const over = addAttachment(list(4), PNG_SIG, { id: ids, maxCount: 4 });
    expect(over.list).toHaveLength(4);
    expect(over.error).toBe("too-many");
  });

  it("propagates build errors without mutating the list", () => {
    const result = addAttachment(list(1), junk, { id: ids });
    expect(result.list).toHaveLength(1);
    expect(result.error).toBe("unsupported-format");
  });

  it("removes only the most recently added attachment", () => {
    const three = list(3);
    const { list: after, removed } = removeLastAttachment(three);
    expect(after).toHaveLength(2);
    expect(after).toEqual(three.slice(0, 2));
    expect(removed?.id).toBe("a2");
    expect(removeLastAttachment([])).toEqual({ list: [] });
  });
});

describe("captions and rejection messages", () => {
  it("formats a compact, numbered caption with size in KB and dimensions", () => {
    const a: PendingAttachment = {
      id: "x",
      mimeType: "image/png",
      data: "",
      bytes: 43_008,
      width: 1024,
      height: 768,
    };
    expect(attachmentCaption(a, 0)).toBe("[1] image/png 1024x768, 42.0 KB");
    const noDims: PendingAttachment = { id: "y", mimeType: "image/jpeg", data: "", bytes: 1024 };
    expect(attachmentCaption(noDims, 3)).toBe("[4] image/jpeg 1.0 KB");
  });

  it("explains every rejection reason in one line, mentioning the configured limits", () => {
    const opts = { maxBytes: 5 * 1024 * 1024, maxCount: 4 };
    const reasons: AttachmentRejection[] = ["empty", "unsupported-format", "too-large", "too-many"];
    for (const r of reasons) {
      const msg = rejectionMessage(r, opts);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/undefined|NaN/);
    }
    expect(rejectionMessage("too-large", opts)).toMatch(/5(\.0)? ?MB|5242880/i);
    expect(rejectionMessage("too-many", opts)).toContain("4");
  });

  it("maps a pending attachment to the SDK content shape", () => {
    const a: PendingAttachment = {
      id: "x",
      mimeType: "image/png",
      data: "QQ==",
      bytes: 1,
      width: 2,
      height: 3,
    };
    expect(toApiAttachment(a)).toEqual({
      kind: "image",
      mimeType: "image/png",
      data: "QQ==",
      bytes: 1,
      width: 2,
      height: 3,
    });
    const noDims: PendingAttachment = { id: "y", mimeType: "image/png", data: "QQ==", bytes: 1 };
    expect(toApiAttachment(noDims)).toEqual({
      kind: "image",
      mimeType: "image/png",
      data: "QQ==",
      bytes: 1,
    });
  });
});

describe("pasting from the clipboard", () => {
  it("is a graceful no-op when no native clipboard helper exists", async () => {
    const result = await pasteImageFromClipboard(undefined, []);
    expect(result.list).toEqual([]);
    expect(result.message).toMatch(/no native clipboard/i);
  });

  it("reports an empty clipboard and an unavailable image source distinctly", async () => {
    const empty = await pasteImageFromClipboard({ getImage: async () => null }, []);
    expect(empty.message).toMatch(/no image/i);
    const unavailable = await pasteImageFromClipboard({ getImage: async () => undefined }, []);
    expect(unavailable.message).toMatch(/not available/i);
  });

  it("attaches a valid image and surfaces read failures without throwing", async () => {
    const ok = await pasteImageFromClipboard({ getImage: async () => PNG_SIG }, [], { id: ids });
    expect(ok.list).toHaveLength(1);
    expect(ok.message).toBeUndefined();
    const failing = await pasteImageFromClipboard(
      { getImage: async () => Promise.reject(new Error("transfer failed")) },
      [],
    );
    expect(failing.list).toEqual([]);
    expect(failing.message).toMatch(/transfer failed/);
  });

  it("applies the same size and count limits as a direct paste", async () => {
    const tooMany = await pasteImageFromClipboard({ getImage: async () => PNG_SIG }, [
      { id: "a", mimeType: "image/png", data: "", bytes: 1 },
      { id: "b", mimeType: "image/png", data: "", bytes: 1 },
      { id: "c", mimeType: "image/png", data: "", bytes: 1 },
      { id: "d", mimeType: "image/png", data: "", bytes: 1 },
    ]);
    expect(tooMany.list).toHaveLength(4);
    expect(tooMany.message).toMatch(/maximum|4/i);
  });
});
