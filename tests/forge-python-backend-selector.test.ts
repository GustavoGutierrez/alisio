/**
 * `PythonBackendSelector` (Python spec §6, P2/P4): a deterministic chain of rules over facts the
 * caller already gathered. Pure: no probing here. An explicit `analysis.runtime` is honored and
 * never replaced silently; `auto` walks oci -> wasm -> managed under `analysis.isolation`.
 */
import { describe, expect, it } from "vitest";
import { isForgeError } from "../packages/core/src/forge/errors.ts";
import {
  createPythonBackendSelector,
  engineIdOf,
  neededBackends,
  type PythonSelectionContext,
} from "../packages/core/src/forge/python/backend-selector.ts";

const READY = { ready: true } as const;
const down = (reason: string) => ({ ready: false, reason }) as const;
const selector = createPythonBackendSelector();
const pick = (context: PythonSelectionContext) => selector.select(context);
const rejection = (context: PythonSelectionContext) => {
  try {
    selector.select(context);
  } catch (error) {
    if (isForgeError(error)) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("explicit runtime (FP-AC-02, FP-AC-03 explicit variant)", () => {
  it("managed ready -> managed, with the setting as the reason", () => {
    expect(pick({ runtime: "managed", readiness: { managed: READY } })).toEqual({
      engine: "managed",
      reason: "analysis.runtime=managed",
    });
  });

  it("oci ready -> oci", () => {
    expect(pick({ runtime: "oci", readiness: { oci: READY, managed: READY } })).toEqual({
      engine: "oci",
      reason: "analysis.runtime=oci",
    });
  });

  it("an unready configured backend is an error with its reason, never a switch to the other one", () => {
    const error = rejection({
      runtime: "oci",
      readiness: { oci: down("docker was not found on PATH"), managed: READY },
    });
    expect(error.code).toBe("ENGINE_UNAVAILABLE");
    expect(error.message).toContain("docker was not found on PATH");
    const managed = rejection({
      runtime: "managed",
      readiness: { managed: down("no Python"), oci: READY },
    });
    expect(managed.message).toContain("no Python");
  });

  it("a backend nobody checked is not ready", () => {
    expect(rejection({ runtime: "oci", readiness: {} }).code).toBe("ENGINE_UNAVAILABLE");
  });
});

describe("rerunOf prefers the original backend under auto (PD12, FP-AC-21)", () => {
  it("an explicit runtime beats the original backend of a rerun (§6.1 rule 1)", () => {
    expect(
      pick({
        runtime: "managed",
        rerunOfBackend: "oci",
        readiness: { managed: READY, oci: READY },
      }),
    ).toEqual({ engine: "managed", reason: "analysis.runtime=managed" });
  });

  it("auto goes back to the original backend when it is ready and the policy allows it", () => {
    expect(
      pick({
        runtime: "auto",
        rerunOfBackend: "wasm",
        readiness: { oci: READY, wasm: READY, managed: READY },
      }),
    ).toEqual({ engine: "wasm", reason: "rerun: original backend wasm" });
  });

  it("auto selects anew, saying why, when the original backend is not ready (FP-AC-21)", () => {
    const selection = pick({
      runtime: "auto",
      rerunOfBackend: "wasm",
      readiness: { oci: READY, wasm: down("node 20 is too old") },
    });
    expect(selection.engine).toBe("oci");
    expect(selection.reason).toContain("rerun: original backend wasm");
    expect(selection.reason).toContain("node 20 is too old");
  });

  it("auto never reruns on a managed original when the policy forbids the host", () => {
    const selection = pick({
      runtime: "auto",
      isolation: "required",
      rerunOfBackend: "managed",
      readiness: { oci: READY, managed: READY },
    });
    expect(selection.engine).toBe("oci");
    expect(selection.reason).toContain("rerun: original backend managed");
  });
});

describe("auto (FP-AC-03, FP-AC-04, FP-AC-05)", () => {
  it("prefers oci, then wasm, then managed, the first one ready", () => {
    expect(
      pick({ runtime: "auto", readiness: { oci: READY, wasm: READY, managed: READY } }).engine,
    ).toBe("oci");
    const wasm = pick({
      runtime: "auto",
      readiness: { oci: down("no docker"), wasm: READY, managed: READY },
    });
    expect(wasm.engine).toBe("wasm");
    expect(wasm.reason).toContain("oci: not ready (no docker)");
    expect(
      pick({
        runtime: "auto",
        readiness: { oci: down("no docker"), wasm: down("not installed"), managed: READY },
      }).engine,
    ).toBe("managed");
  });

  it("drops wasm when the script does not fit it and uses the next backend that does (FP-AC-05)", () => {
    const selection = pick({
      runtime: "auto",
      readiness: { oci: down("no docker"), wasm: READY, managed: READY },
      support: {
        wasm: {
          ok: false,
          code: "PACKAGE_UNAVAILABLE",
          reason: "module torch is not in the wasm profiles",
        },
      },
    });
    expect(selection.engine).toBe("managed");
    expect(selection.reason).toContain("wasm: module torch is not in the wasm profiles");
  });

  it("keeps the host out unless the policy is preferred, and says so", () => {
    const required = rejection({
      runtime: "auto",
      isolation: "required",
      readiness: { oci: down("no docker"), wasm: down("not installed"), managed: READY },
    });
    expect(required.code).toBe("ENGINE_UNAVAILABLE");
    expect(required.message).toContain("managed: excluded by analysis.isolation=required");
    // Required still admits wasm, which has no network denial.
    expect(
      pick({
        runtime: "auto",
        isolation: "required",
        readiness: { oci: down("no docker"), wasm: READY, managed: READY },
      }).engine,
    ).toBe("wasm");
  });

  it("strict admits only backends whose network is denied by the OS (FP-AC-13, FP-AC-28)", () => {
    const strict = {
      runtime: "auto",
      isolation: "strict",
      readiness: { oci: READY, wasm: READY, managed: READY },
    } as const;
    expect(pick({ ...strict, networkDenied: { oci: true, wasm: false } }).engine).toBe("oci");
    const noOci = rejection({
      ...strict,
      readiness: { oci: down("no docker"), wasm: READY, managed: READY },
      networkDenied: { oci: true, wasm: false },
    });
    expect(noOci.message).toContain("wasm: excluded by analysis.isolation=strict");
    // A wasm whose self-probe found the network closed (Node >= 25) is admitted.
    expect(
      pick({
        ...strict,
        readiness: { oci: down("no docker"), wasm: READY },
        networkDenied: { wasm: true },
      }).engine,
    ).toBe("wasm");
  });

  it("with nothing usable it lists every reason and the shortest command that would help (FP-AC-06)", () => {
    const error = rejection({
      runtime: "auto",
      isolation: "required",
      readiness: { oci: down("docker was not found"), wasm: down("pyodide is not installed") },
    });
    expect(error.message).toContain("oci: not ready (docker was not found)");
    expect(error.message).toContain("wasm: not ready (pyodide is not installed)");
    expect(error.message).toContain("alisio analysis setup --wasm");
  });

  it("suggests the profile that would make wasm fit, and oci when wasm cannot be made to fit", () => {
    const profile = rejection({
      runtime: "auto",
      isolation: "required",
      readiness: { oci: down("no docker"), wasm: READY },
      support: {
        wasm: {
          ok: false,
          code: "PROFILE_UNSUPPORTED",
          reason: "needs the science profile",
          fix: "alisio analysis setup --wasm --profile science",
        },
      },
    });
    expect(profile.message).toContain("alisio analysis setup --wasm --profile science");
    const big = rejection({
      runtime: "auto",
      isolation: "required",
      readiness: { oci: down("no docker"), wasm: READY },
      support: { wasm: { ok: false, code: "INPUT_TOO_LARGE", reason: "inputs exceed 100 MB" } },
    });
    expect(big.message).toContain("alisio analysis setup --oci");
    expect(big.message).not.toContain("setup --wasm");
  });
});

describe("explicit runtime and the isolation policy", () => {
  it("an explicit wasm that cannot run this script is an error with the alternative, not a switch (FP-AC-07)", () => {
    const error = rejection({
      runtime: "wasm",
      readiness: { wasm: READY, oci: READY, managed: READY },
      support: {
        wasm: { ok: false, code: "PACKAGE_UNAVAILABLE", reason: "module torch is not available" },
      },
    });
    expect(error.message).toContain("wasm cannot run this script: module torch is not available");
    expect(error.message).toContain("analysis.runtime=auto");
  });

  it("an explicit wasm that is not installed names the setup command", () => {
    const error = rejection({
      runtime: "wasm",
      readiness: { wasm: down("pyodide is not installed") },
    });
    expect(error.message).toContain("wasm is not ready: pyodide is not installed");
    expect(error.message).toContain("alisio analysis setup --wasm");
  });

  it("an explicit managed is refused while the policy forbids the host, never run", () => {
    const error = rejection({
      runtime: "managed",
      isolation: "required",
      readiness: { managed: READY },
    });
    expect(error.message).toContain("analysis.isolation=required");
  });

  it("an explicit wasm is refused under strict while its network is open", () => {
    const error = rejection({
      runtime: "wasm",
      isolation: "strict",
      readiness: { wasm: READY },
      networkDenied: { wasm: false },
    });
    expect(error.message).toContain("analysis.isolation=strict");
  });
});

describe("the reason line and the way out are exact", () => {
  it("auto names the backend and the policy and nothing else when nothing was skipped", () => {
    expect(pick({ runtime: "auto", readiness: { oci: READY } })).toEqual({
      engine: "oci",
      reason: "analysis.runtime=auto, analysis.isolation=preferred: oci is ready",
    });
  });

  it("an explicit managed that is not ready gives the plain reason (the host hints come from the tool)", () => {
    expect(
      rejection({ runtime: "managed", readiness: { managed: down("no Python") } }).message,
    ).toBe("managed is not ready: no Python");
  });

  it("an explicit runtime repeating a rerun says it is a repeat", () => {
    expect(pick({ runtime: "oci", rerunOfBackend: "oci", readiness: { oci: READY } })).toEqual({
      engine: "oci",
      reason: "rerun: original backend oci",
    });
  });

  it("a backend can name its own fix, or say that no command helps", () => {
    const custom = rejection({
      runtime: "wasm",
      readiness: {
        wasm: {
          ready: false,
          reason: "needs a newer profile",
          fix: "alisio analysis setup --wasm --profile science",
        },
      },
    });
    expect(custom.message).toContain('run "alisio analysis setup --wasm --profile science"');
    const none = rejection({
      runtime: "wasm",
      readiness: { wasm: { ready: false, reason: "no node 22.16+ on PATH", fix: "" } },
    });
    expect(none.message).toBe(
      "wasm is not ready: no node 22.16+ on PATH; set analysis.runtime=auto",
    );
    const auto = rejection({
      runtime: "auto",
      isolation: "required",
      readiness: { oci: down("no docker"), wasm: { ready: false, reason: "no node", fix: "" } },
    });
    expect(auto.message).toContain('Shortest fix: run "alisio analysis setup --oci"');
    expect(auto.message).not.toContain("setup --wasm");
  });

  it("strict treats a backend with no network answer as open", () => {
    const error = rejection({
      runtime: "auto",
      isolation: "strict",
      readiness: { oci: READY, wasm: READY },
    });
    expect(error.message).toContain("oci: excluded by analysis.isolation=strict");
    expect(error.message).toContain("wasm: excluded by analysis.isolation=strict");
  });
});

describe("helpers", () => {
  it("lists only the backends worth probing: the configured one and the original of a rerun", () => {
    expect(neededBackends({ runtime: "managed" })).toEqual(["managed"]);
    expect(neededBackends({ runtime: "managed", rerunOfBackend: "oci" })).toEqual([
      "managed",
      "oci",
    ]);
    expect(neededBackends({ runtime: "oci", rerunOfBackend: "oci" })).toEqual(["oci"]);
  });

  it("an explicit runtime still probes a rerun's isolated original under a strict policy", () => {
    expect(
      neededBackends({ runtime: "wasm", isolation: "required", rerunOfBackend: "oci" }),
    ).toEqual(["wasm", "oci"]);
  });

  it("auto probes every candidate in its order, and the host only when the policy admits it", () => {
    expect(neededBackends({ runtime: "auto" })).toEqual(["oci", "wasm", "managed"]);
    expect(neededBackends({ runtime: "auto", isolation: "required" })).toEqual(["oci", "wasm"]);
    expect(
      neededBackends({ runtime: "auto", isolation: "required", rerunOfBackend: "managed" }),
    ).toEqual(["oci", "wasm"]);
  });

  it("names the Forja engine of a backend", () => {
    expect(engineIdOf("managed")).toBe("python-managed");
    expect(engineIdOf("oci")).toBe("python-oci");
    expect(engineIdOf("wasm")).toBe("python-wasm");
  });
});
