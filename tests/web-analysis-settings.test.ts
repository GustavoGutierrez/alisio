/**
 * The pure logic behind Settings → Data analysis: which keys the page owns, whole-number parsing
 * with the schema's bounds (the server validates again), and the timeout shown in seconds. The
 * i18n parity of the new strings is enforced by the existing dictionary test.
 */
import type { SettingInfo } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { settableSettings } from "../packages/core/src/index.ts";
import {
  ANALYSIS_KEYS,
  analysisSetting,
  extrasLabel,
  isAnalysisKey,
  msToSeconds,
  parseWhole,
  secondsToMs,
} from "../packages/web/src/util/analysis.ts";

describe("analysis settings page logic", () => {
  it("owns exactly the analysis keys the config accepts, and General leaves them out", () => {
    const accepted = settableSettings()
      .map((s) => s.key)
      .filter(isAnalysisKey);
    expect([...ANALYSIS_KEYS].sort()).toEqual([...accepted].sort());
    expect(isAnalysisKey("limits.timeoutMs")).toBe(false);
    expect(isAnalysisKey("analysis.runtime")).toBe(true);
  });

  it("parses whole numbers inside the bounds and rejects everything else", () => {
    expect(parseWhole("30", 0, 3650)).toBe(30);
    expect(parseWhole(" 0 ", 0, 3650)).toBe(0);
    expect(parseWhole("3650", 0, 3650)).toBe(3650);
    for (const bad of ["", " ", "-1", "3651", "1.5", "1e3", "abc", "０"])
      expect(parseWhole(bad, 0, 3650), bad).toBeUndefined();
  });

  it("shows the timeout in seconds and stores milliseconds within 1–900 s", () => {
    expect(msToSeconds(120_000)).toBe(120);
    expect(secondsToMs("120")).toBe(120_000);
    expect(secondsToMs("1")).toBe(1000);
    expect(secondsToMs("900")).toBe(900_000);
    expect(secondsToMs("0")).toBeUndefined();
    expect(secondsToMs("901")).toBeUndefined();
    expect(secondsToMs("1.5")).toBeUndefined();
  });

  it("reads a key's value from the settings overview", () => {
    const settings: SettingInfo[] = [
      { key: "analysis.enabled", kind: "boolean", value: false },
      { key: "analysis.retention.jobsDays", kind: "number", value: 14 },
      { key: "analysis.retention.artifactsDays", kind: "number" },
    ];
    expect(analysisSetting(settings, "analysis.enabled")).toBe(false);
    expect(analysisSetting(settings, "analysis.retention.jobsDays")).toBe(14);
    expect(analysisSetting(settings, "analysis.retention.artifactsDays")).toBeUndefined();
    expect(analysisSetting(settings, "analysis.limits.timeoutMs")).toBeUndefined();
    expect(extrasLabel(["analysis", "science"])).toBe("analysis, science");
  });
});
