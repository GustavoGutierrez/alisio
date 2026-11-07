import { describe, expect, it } from "vitest";
import { classifyNavigation } from "../apps/desktop/src/navigation.ts";

const APP = "http://127.0.0.1:4317/?token=abc";

describe("desktop navigation policy", () => {
  it("keeps same-origin navigation inside the window", () => {
    expect(classifyNavigation("http://127.0.0.1:4317/sessions/1", APP)).toBe("allow");
  });

  it("sends http(s) and mailto links to the system handler", () => {
    for (const url of ["https://example.com/x", "http://127.0.0.1:9999/", "mailto:a@b.c"])
      expect(classifyNavigation(url, APP), url).toBe("external");
  });

  it("denies everything else, including malformed URLs", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "nope", ""])
      expect(classifyNavigation(url, APP), url).toBe("deny");
  });
});
