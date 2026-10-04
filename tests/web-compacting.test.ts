import type { RunEvent, ServerFrame } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { composerSendBlocked } from "../packages/web/src/store/composer.ts";
import { applyCompacting } from "../packages/web/src/store/progress.ts";

const SID = "s1";
let n = 0;
/** `runId` is empty for a manual `/compact`: it has no run. */
const event = (type: string, runId = ""): ServerFrame => ({
  t: "event",
  sessionId: SID,
  event: {
    schemaVersion: 1,
    runId,
    sessionId: SID,
    seq: ++n,
    type,
    timestamp: new Date().toISOString(),
    data: {},
    eventId: String(n),
  } as unknown as RunEvent,
});
const snapshot = { t: "snapshot", sessionId: SID, cursor: 0 } as unknown as ServerFrame;
const status = (value: string) =>
  ({ t: "session_status", sessionId: SID, workspaceId: "w", status: value }) as ServerFrame;

describe("compacting signal", () => {
  it("is set by compaction_started even without a run (manual /compact)", () => {
    expect(applyCompacting(false, event("compaction_started"))).toBe(true);
  });
  it("is cleared by completed, failed and skipped", () => {
    for (const type of ["compaction_completed", "compaction_failed", "compaction_skipped"])
      expect(applyCompacting(true, event(type))).toBe(false);
  });
  it("is cleared when a run ends so a stale flag cannot lock the composer", () => {
    for (const type of ["run_failed", "run_cancelled", "run_completed"])
      expect(applyCompacting(true, event(type, "r1"))).toBe(false);
  });
  it("is cleared by a snapshot and by a session that is no longer working", () => {
    expect(applyCompacting(true, snapshot)).toBe(false);
    expect(applyCompacting(true, status("idle"))).toBe(false);
    expect(applyCompacting(true, status("error"))).toBe(false);
    expect(applyCompacting(true, status("running"))).toBe(true);
  });
  it("ignores unrelated frames", () => {
    expect(applyCompacting(true, event("turn_completed", "r1"))).toBe(true);
    expect(applyCompacting(false, event("turn_completed", "r1"))).toBe(false);
  });
});

describe("composer send gate", () => {
  it("blocks sending while compacting or disabled, never otherwise", () => {
    expect(composerSendBlocked({ disabled: false, compacting: false })).toBe(false);
    expect(composerSendBlocked({ disabled: false, compacting: true })).toBe(true);
    expect(composerSendBlocked({ disabled: true, compacting: false })).toBe(true);
  });
  it("has EN and ES text for the indicator and the blocked send", () => {
    for (const dict of [en, es] as Array<Record<string, string>>) {
      expect(dict["run.phase.compacting"]).toBeTruthy();
      expect(dict["composer.compacting"]).toBeTruthy();
    }
  });
});
