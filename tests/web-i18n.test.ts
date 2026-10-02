/** Web i18n safety: every settable key is labeled in both locales and `t()` never throws. */
import { settableSettings } from "@alisio/core";
import { describe, expect, it } from "vitest";
import { SETTING_LABELS, settingLabel } from "../packages/web/src/components/settings/labels.ts";
import { t } from "../packages/web/src/i18n/index.ts";

describe("web i18n", () => {
  it("labels every settable key in English and Spanish", () => {
    const missing: string[] = [];
    for (const { key } of settableSettings()) {
      if (!SETTING_LABELS.en[key]) missing.push(`en:${key}`);
      if (!SETTING_LABELS.es[key]) missing.push(`es:${key}`);
    }
    expect(missing).toEqual([]);
  });

  it("has no label for a key the server cannot return (stale labels are removed)", () => {
    const settable = new Set(settableSettings().map((s) => s.key as string));
    for (const locale of ["en", "es"] as const)
      expect(Object.keys(SETTING_LABELS[locale]).filter((key) => !settable.has(key))).toEqual([]);
  });

  it("an unknown setting renders its key instead of throwing", () => {
    expect(settingLabel("brand.new.key", "en")).toBe("brand.new.key");
    expect(settingLabel("brand.new.key", "es")).toBe("brand.new.key");
    expect(settingLabel("limits.timeoutMs", "es")).toContain("(ms)");
  });

  it("the translator renders the key text for an unknown message key instead of throwing", () => {
    expect(t("not.a.real.key" as never)).toBe("not.a.real.key");
    expect(t("not.a.real.key {x}" as never, { x: 1 })).toBe("not.a.real.key 1");
  });
});
