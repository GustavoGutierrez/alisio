/**
 * Optional smoke test against the real official registry (anonymous, read-only GETs, one small
 * page). Skipped by default: set ALISIO_LIVE_MCP_REGISTRY=1 to run it.
 */
import { describe, expect, it } from "vitest";
import { OfficialRegistrySource } from "../packages/core/src/mcp/catalog/sources/official-registry.ts";

const live = process.env.ALISIO_LIVE_MCP_REGISTRY === "1";

describe.skipIf(!live)("official registry (live smoke, ALISIO_LIVE_MCP_REGISTRY=1)", () => {
  it("maps a real page into the domain model", async () => {
    const source = new OfficialRegistrySource();
    const page = await source.listPage({ limit: 20 });
    expect(page.entries.length + page.rejected.length).toBeGreaterThan(0);
    for (const entry of page.entries) {
      expect(entry.sourceId).toBe("official");
      expect(entry.name).toBeTruthy();
      expect(entry.provenance.rawDigest).toHaveLength(64);
    }
    for (const r of page.rejected)
      expect(["schema_unsupported", "invalid", "too_large"]).toContain(r.reason);
    const first = page.entries[0];
    if (first) expect((await source.get(first.name, first.version))?.name).toBe(first.name);
  });
});
