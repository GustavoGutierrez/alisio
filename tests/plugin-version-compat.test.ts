import { describe, expect, it } from "vitest";
import {
  catalogPluginState,
  comparePluginVersions,
  satisfiesRange,
} from "../packages/core/src/index.ts";

describe("comparePluginVersions", () => {
  it.each([
    ["1.2.3", "1.2.3", 0],
    ["1.2.4", "1.2.3", 1],
    ["0.9.0", "0.10.0", -1],
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["v1.0.0", "1.0.0", 0],
  ])("%s vs %s", (a, b, expected) => {
    expect(Math.sign(comparePluginVersions(a, b) as number)).toBe(expected);
  });
  it("returns undefined for a malformed version", () => {
    expect(comparePluginVersions("latest", "1.0.0")).toBeUndefined();
  });
});

describe("satisfiesRange", () => {
  it.each([
    ["0.9.0", "^0.9.0", true],
    ["0.9.7", "^0.9.0", true],
    ["0.10.0", "^0.9.0", false],
    ["0.8.9", "^0.9.0", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["1.4.0", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["2.0.0", ">=1.0.0 <3.0.0", true],
    ["3.0.0", ">=1.0.0 <3.0.0", false],
    ["0.8.0", "^0.9.0 || ^0.8.0", true],
    ["5.0.0", "*", true],
    ["1.5.0", "1.x", true],
    ["2.5.0", "1.x", false],
    ["0.9.0-rc.1", "^0.9.0", true],
  ])("%s in %s -> %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
  it("treats an unparseable range as not satisfied", () => {
    expect(satisfiesRange("1.0.0", "workspace:*")).toBe(false);
  });
});

describe("catalogPluginState", () => {
  const base = { catalogVersion: "0.5.0", sdkRange: "^0.9.0", sdkVersion: "0.9.2" };
  it("not installed and compatible", () => {
    expect(catalogPluginState(base)).toEqual({ compatible: true, updateAvailable: false });
  });
  it("installed and current", () => {
    expect(catalogPluginState({ ...base, installedVersion: "0.5.0" })).toEqual({
      compatible: true,
      updateAvailable: false,
      installedVersion: "0.5.0",
    });
  });
  it("installed and older: update available", () => {
    expect(catalogPluginState({ ...base, installedVersion: "0.4.0" }).updateAvailable).toBe(true);
  });
  it("installed and newer than the catalog: no update", () => {
    expect(catalogPluginState({ ...base, installedVersion: "0.6.0" }).updateAvailable).toBe(false);
  });
  it("incompatible sdk range", () => {
    expect(catalogPluginState({ ...base, sdkRange: "^0.8.0" }).compatible).toBe(false);
  });
  it("unknown sdk version is not reported as incompatible", () => {
    expect(
      catalogPluginState({ ...base, sdkVersion: undefined, sdkRange: "^0.8.0" }).compatible,
    ).toBe(true);
  });
  it("a missing sdk range is compatible", () => {
    expect(catalogPluginState({ ...base, sdkRange: undefined }).compatible).toBe(true);
  });
});
