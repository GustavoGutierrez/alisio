/** The Alisio version in the web UI: the server's `/api/health` version, with a safe fallback. */
import type { HealthInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { t } from "../packages/web/src/i18n/index.ts";
import { appVersion, health } from "../packages/web/src/store/app.ts";
import { normalizeVersion } from "../packages/web/src/util/version.ts";

const info = (version: unknown): HealthInfo =>
  ({ name: "alisio", version, protocolVersion: 1, capabilities: {} }) as unknown as HealthInfo;

afterEach(() => {
  health.value = undefined;
});

describe("normalizeVersion", () => {
  it("keeps a real version and trims it", () => {
    expect(normalizeVersion("0.1.1")).toBe("0.1.1");
    expect(normalizeVersion(" 0.2.0-alpha.3 ")).toBe("0.2.0-alpha.3");
  });

  it("treats a missing, empty or non-string field as unknown", () => {
    for (const raw of [undefined, null, "", "   ", 1, {}])
      expect(normalizeVersion(raw)).toBeUndefined();
  });
});

describe("appVersion", () => {
  it("is unknown until the health payload arrives and follows it afterwards", () => {
    expect(appVersion.value).toBeUndefined();
    health.value = info("0.1.1");
    expect(appVersion.value).toBe("0.1.1");
  });

  it("falls back to unknown when an older or odd server omits the version", () => {
    health.value = info(undefined);
    expect(appVersion.value).toBeUndefined();
    health.value = info("");
    expect(appVersion.value).toBeUndefined();
  });

  it("shows a development build as `dev` rather than hiding it", () => {
    health.value = info("dev");
    expect(appVersion.value).toBe("dev");
  });
});

describe("version strings", () => {
  it("formats the label and has an unknown fallback in both locales", () => {
    expect(en["about.version"].replace("{version}", "0.1.1")).toBe("Alisio 0.1.1");
    expect(es["about.version"].replace("{version}", "0.1.1")).toBe("Alisio 0.1.1");
    expect(en["about.versionUnknown"]).not.toBe("");
    expect(es["about.versionUnknown"]).not.toBe("");
    expect(t("about.version", { version: "0.1.1" })).toBe("Alisio 0.1.1");
  });
});
