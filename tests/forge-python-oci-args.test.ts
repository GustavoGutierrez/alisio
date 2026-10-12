/**
 * The additive parts of `ociRunArgs` (Forja Python spec §4.3, Forja spec §9.4): the scratchpad as a
 * read-only mount and the variables of the Forja transport. A plain run is pinned exactly in
 * analysis-python-characterization.
 */
import { describe, expect, it } from "vitest";
import { type OciHost, ociRunArgs } from "../packages/core/src/analysis/oci.ts";

const IMAGE = `registry.example/python@sha256:${"d".repeat(64)}`;
const host: OciHost = { platform: "linux", uid: 1000, gid: 1000 };
const mounts = {
  script: "/state/jobs/exec_1/script",
  input: "/state/jobs/exec_1/input",
  work: "/state/jobs/exec_1/work",
  staging: "/state/jobs/exec_1/staging",
};
const args = (extra: { scratch?: string; env?: Record<string, string> } = {}) =>
  ociRunArgs({
    settings: { engine: "docker", image: IMAGE, memoryMb: 512, cpus: 1 },
    executionId: "exec_1",
    mounts: { ...mounts, ...(extra.scratch ? { scratch: extra.scratch } : {}) },
    host,
    ...(extra.env ? { env: extra.env } : {}),
  });
const flagValues = (list: string[], flag: string) =>
  list.flatMap((x, i) => (x === flag ? [list[i + 1]] : []));

describe("ociRunArgs with the Forja scratchpad", () => {
  it("mounts it read-only at /job/scratch, after the writable mounts, and names it in the environment", () => {
    const a = args({ scratch: "/tmp/alisio-1000/ws/s1/scratchpad" });
    expect(flagValues(a, "-v")).toEqual([
      `${mounts.script}:/job/script:ro`,
      `${mounts.input}:/job/input:ro`,
      `${mounts.work}:/job/work:rw`,
      `${mounts.staging}:/job/out:rw`,
      "/tmp/alisio-1000/ws/s1/scratchpad:/job/scratch:ro",
    ]);
    expect(flagValues(a, "-e")).toContain("ALISIO_SCRATCH_DIR=/job/scratch");
    expect(a.join(" ")).not.toContain("/job/scratch:rw");
  });

  it("without a scratchpad no mount and no variable appear", () => {
    const a = args();
    expect(a.join(" ")).not.toContain("scratch");
  });

  it("relabels the scratchpad mount like the others when SELinux enforces", () => {
    const a = ociRunArgs({
      settings: { engine: "docker", image: IMAGE, memoryMb: 512, cpus: 1 },
      executionId: "exec_1",
      mounts: { ...mounts, scratch: "/pad" },
      host: { ...host, selinux: true },
    });
    expect(flagValues(a, "-v").at(-1)).toBe("/pad:/job/scratch:ro,z");
  });

  it("refuses a scratchpad path the engine would misparse as mount syntax", () => {
    expect(() => args({ scratch: "/pad:with-colon" })).toThrow(/cannot mount/);
  });

  it("passes the extra variables of the transport after the fixed ones", () => {
    const a = args({ env: { ALISIO_FORGE_NONCE: "abc", ALISIO_FORGE_ENGINE: "python-oci" } });
    const env = flagValues(a, "-e");
    expect(env.slice(-2)).toEqual(["ALISIO_FORGE_NONCE=abc", "ALISIO_FORGE_ENGINE=python-oci"]);
  });
});
