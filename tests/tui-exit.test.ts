import { describe, expect, it } from "vitest";
import {
  bounded,
  EXIT_PENDING_CAP_MS,
  EXIT_SESSION_END_CAP_MS,
} from "../packages/cli/src/tui/exit.ts";

describe("TUI exit bounds", () => {
  it("bounds a hanging shutdown step to its cap and never rejects", async () => {
    const start = Date.now();
    await bounded(new Promise<void>(() => {}), 100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("resolves promptly when the step settles first, including rejections", async () => {
    const start = Date.now();
    await bounded(Promise.reject(new Error("teardown failed")), 5_000);
    await bounded(Promise.resolve("done"), 5_000);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("exposes the documented caps: 3s pending, 1.5s session-end hooks", () => {
    expect(EXIT_PENDING_CAP_MS).toBe(3_000);
    expect(EXIT_SESSION_END_CAP_MS).toBe(1_500);
  });
});
