import { describe, expect, it } from "vitest";
import {
  absolutePath,
  extensionOf,
  fileName,
  parentDirs,
  previewKind,
  workspaceRelative,
} from "../packages/web/src/util/files.ts";

describe("dock paths", () => {
  it("turns tool and Markdown paths into workspace-relative ones", () => {
    expect(workspaceRelative("/ws", "src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelative("/ws", "./src/../lib/b.ts")).toBe("lib/b.ts");
    expect(workspaceRelative("/ws/", "/ws/src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelative("/ws", "/ws")).toBe("");
    expect(workspaceRelative("/ws", "src/a.ts:12")).toBe("src/a.ts");
    expect(workspaceRelative("/ws", "README.md#install")).toBe("README.md");
  });

  it("rejects paths that are not workspace files", () => {
    expect(workspaceRelative("/ws", "/etc/passwd")).toBeUndefined();
    expect(workspaceRelative("/ws", "/wsx/a")).toBeUndefined();
    expect(workspaceRelative("/ws", "../outside")).toBeUndefined();
    expect(workspaceRelative("/ws", "https://example.com/a")).toBeUndefined();
    expect(workspaceRelative("/ws", "javascript:alert(1)")).toBeUndefined();
    expect(workspaceRelative("/ws", "#heading")).toBeUndefined();
    expect(workspaceRelative(undefined, "/abs")).toBeUndefined();
  });

  it("lists the directories to expand to reach a file", () => {
    expect(parentDirs("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(parentDirs("c.ts")).toEqual([]);
  });

  it("chooses the preview from the sniffed type, then the extension", () => {
    expect(previewKind("x.png", "image/png")).toBe("image");
    expect(previewKind("fake.png", "text/plain; charset=utf-8")).toBe("code");
    expect(previewKind("README.MD", "text/plain; charset=utf-8")).toBe("markdown");
    expect(previewKind("a.json", "text/plain")).toBe("json");
    expect(previewKind("a.bin", "application/octet-stream")).toBe("binary");
    expect(previewKind("doc.pdf", "application/pdf")).toBe("pdf");
    expect(previewKind("page.html", "text/plain; charset=utf-8")).toBe("html");
    expect(previewKind("page.htm", "text/plain; charset=utf-8")).toBe("html");
    expect(extensionOf("dir.v2/Makefile")).toBe("");
    expect(extensionOf(".env")).toBe("");
  });

  it("builds the absolute path with the workspace's own separator", () => {
    expect(absolutePath("/home/me/ws", "src/a.ts")).toBe("/home/me/ws/src/a.ts");
    expect(absolutePath("/home/me/ws/", "src/a.ts")).toBe("/home/me/ws/src/a.ts");
    expect(absolutePath("C:\\work\\ws", "src/a.ts")).toBe("C:\\work\\ws\\src\\a.ts");
    expect(absolutePath("/home/me/ws", "")).toBe("/home/me/ws");
    expect(absolutePath(undefined, "src/a.ts")).toBeUndefined();
  });

  it("takes the file name with its extension", () => {
    expect(fileName("a/b/c.ts")).toBe("c.ts");
    expect(fileName("c.ts")).toBe("c.ts");
  });
});
