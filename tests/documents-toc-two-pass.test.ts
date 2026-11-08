import { describe, expect, it } from "vitest";
import {
  pagesFromLinks,
  type TocMode,
  twoPassToc,
} from "../packages/core/src/documents/toc-two-pass.ts";

const link = (name: string, page: number) => ({ from: 2, name, page });

describe("pagesFromLinks", () => {
  it("maps heading ids to the page of the matching link and ignores the rest", () => {
    const ids = new Set(["a", "b"]);
    const map = pagesFromLinks([link("a", 3), link("b", 5), link("zzz", 9), { from: 1 }], ids);
    expect([...map]).toEqual([
      ["a", 3],
      ["b", 5],
    ]);
  });
});

describe("twoPassToc (D-23)", () => {
  const ids = new Set(["a", "b"]);
  /** A renderer whose pages of the headings depend on how wide the injected numbers are. */
  const make = (pagesFor: (mode: TocMode, call: number) => Array<[string, number]>) => {
    const calls: TocMode[] = [];
    const render = async (mode: TocMode) => {
      calls.push(mode);
      return {
        value: { call: calls.length },
        links: pagesFor(mode, calls.length).map(([n, p]) => link(n, p)),
      };
    };
    return { render, calls };
  };

  it("stabilizes in two renders when the numbers do not move the layout", async () => {
    const { render, calls } = make(() => [
      ["a", 3],
      ["b", 4],
    ]);
    const r = await twoPassToc(render, ids);
    expect(r.stable).toBe(true);
    expect(r.passes).toBe(2);
    expect(calls.map((c) => c.kind)).toEqual(["placeholder", "numbers"]);
    expect(r.value).toEqual({ call: 2 });
    expect(r.pages?.get("b")).toBe(4);
  });

  it("uses a third render when the first numbers moved the headings, then stops", async () => {
    const { render, calls } = make((_m, call) => [
      ["a", call === 1 ? 3 : 4],
      ["b", call === 1 ? 4 : 5],
    ]);
    const r = await twoPassToc(render, ids);
    expect(r.stable).toBe(true);
    expect(r.passes).toBe(3);
    expect(calls.map((c) => c.kind)).toEqual(["placeholder", "numbers", "numbers"]);
    expect(r.pages?.get("a")).toBe(4);
  });

  it("falls back to links only when it never stabilizes (three passes at most)", async () => {
    const { render, calls } = make((_m, call) => [
      ["a", call],
      ["b", call + 1],
    ]);
    const r = await twoPassToc(render, ids);
    expect(r.stable).toBe(false);
    expect(calls.map((c) => c.kind)).toEqual(["placeholder", "numbers", "numbers", "none"]);
    expect(r.value).toEqual({ call: 4 });
  });

  it("falls back at once when the PDF has no named destinations for the contents", async () => {
    const { render, calls } = make(() => []);
    const r = await twoPassToc(render, ids);
    expect(r.stable).toBe(false);
    expect(calls.map((c) => c.kind)).toEqual(["placeholder", "none"]);
  });
});
