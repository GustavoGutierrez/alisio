/**
 * The two Forja switches the web page edits (Phase 7b): `forge.javascript.enabled` and
 * `forge.guides.enabled` are live-settable, persisted to the global config, and apply to the
 * workspace application without restarting the server. Every other forge key stays read only.
 */

import type { ForgeOverview, SettingsOverview } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSettableSettingKey,
  setConfigValue,
  settableSettings,
} from "../packages/core/src/index.ts";
import { startTestServer, type TestServer, until } from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("forge settings keys", () => {
  it("makes exactly the JavaScript switch and the guides switch settable", async () => {
    const byKey = Object.fromEntries(settableSettings().map((s) => [s.key, s.kind]));
    expect(byKey["forge.javascript.enabled"]).toBe("boolean");
    expect(byKey["forge.guides.enabled"]).toBe("boolean");
    for (const key of [
      "forge.javascript.host",
      "forge.javascript.timeoutMs",
      "forge.scratch.maxBytes",
      "forge.state.enabled",
    ]) {
      expect(isSettableSettingKey(key), key).toBe(false);
      await expect(setConfigValue({ key: key as never, value: false })).rejects.toThrow(
        /Unknown setting key/,
      );
    }
  });

  it("applies a PATCH to the workspace application and reports it on GET /api/forge", async () => {
    t = await startTestServer();
    const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
    const forge = async () =>
      (await t?.api.get(`/api/forge?workspace=${wid}`))?.json<ForgeOverview>() as ForgeOverview;
    expect((await forge()).javascript.enabled).toBe(true);
    for (const [key, read] of [
      ["forge.javascript.enabled", (f: ForgeOverview) => f.javascript.enabled],
      ["forge.guides.enabled", (f: ForgeOverview) => f.guides.enabled],
    ] as const) {
      const res = await t.api.patch("/api/settings", { workspace: wid, key, value: false });
      expect(res.status, key).toBe(200);
      await until(async () => (read(await forge()) === false ? true : undefined));
      const overview = (await t.api.get(`/api/settings?workspace=${wid}`)).json<SettingsOverview>();
      expect(overview.settings.find((s) => s.key === key)).toMatchObject({
        kind: "boolean",
        value: false,
      });
    }
  });
});
