import { describe, expect, it } from "vitest";
import {
  canSend,
  checkFile,
  MAX_ATTACHMENTS,
  type PendingAttachment,
  readyRefs,
  updateAttachment,
} from "../packages/web/src/store/attachments.ts";

const MB = 1024 * 1024;
const pending = (id: string, extra: Partial<PendingAttachment> = {}): PendingAttachment => ({
  id,
  name: `${id}.png`,
  url: `blob:${id}`,
  bytes: 10,
  status: "uploading",
  ...extra,
});
const ref = (hash: string) => ({ hash, mimeType: "image/png", bytes: 10 });

describe("composer attachments", () => {
  it("accepts PNG, JPEG, GIF and WebP up to 10 MB, within the count limit", () => {
    expect(checkFile({ size: 1, type: "image/png" }, 0)).toBeUndefined();
    expect(checkFile({ size: 10 * MB, type: "image/webp" }, 0)).toBeUndefined();
    expect(checkFile({ size: 25 * MB, type: "image/png" }, 0)).toBe("too-large");
    expect(checkFile({ size: 1, type: "image/svg+xml" }, 0)).toBe("unsupported");
    expect(checkFile({ size: 1, type: "application/pdf" }, 0)).toBe("unsupported");
    expect(checkFile({ size: 0, type: "image/png" }, 0)).toBe("empty");
    expect(checkFile({ size: 1, type: "image/png" }, MAX_ATTACHMENTS)).toBe("too-many");
  });

  it("sends only uploaded references, and only once nothing is still uploading", () => {
    let list = [pending("a"), pending("b")];
    expect(canSend("hi", list)).toBe(false);
    list = updateAttachment(list, "a", { status: "ready", ref: ref("h1") });
    list = updateAttachment(list, "b", { status: "failed", error: "415" });
    expect(readyRefs(list)).toEqual([ref("h1")]);
    expect(canSend("", list)).toBe(true);
    expect(canSend("  ", [])).toBe(false);
    expect(canSend("text", [])).toBe(true);
    expect(canSend("", [pending("c", { status: "failed" })])).toBe(false);
  });
});
