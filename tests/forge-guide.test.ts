/**
 * Forja's incremental context, layer 2 (spec §8.3-§8.4, FJ-AC-21, FJ-AC-22): the `GuideProvider`
 * builds every topic from the live state, each topic stays under 4 KiB, a matching etag answers
 * `unchanged`, and the guide follows what the engines have right now. Pure of I/O: the Python
 * backends are fakes, the JavaScript state is a literal.
 */
import type { EngineDescriptor } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { renderHint } from "../packages/core/src/forge/errors.ts";
import {
  GUIDE_MAX_BYTES,
  GUIDE_TOPICS,
  GuideProvider,
  UnknownGuideTopicError,
} from "../packages/core/src/forge/guides/provider.ts";
import type { PythonEnvironment } from "../packages/core/src/forge/guides/python.ts";
import { probePythonEnvironment } from "../packages/core/src/forge/guides/python-environment.ts";
import { DEFAULT_FORGE_LIMITS } from "../packages/core/src/forge/limits.ts";
import { FORGE_EXCLUDED_TOOLS } from "../packages/core/src/forge/nested.ts";
import type { PythonBackend, PythonBackendId } from "../packages/core/src/forge/python/backend.ts";
import {
  FORGE_GUIDE_DESCRIPTION_MAX_CHARS,
  forgeGuideDescription,
  registerForgeGuide,
} from "../packages/core/src/tools/forge-guide.ts";

const jsState = {
  version: "quickjs-wasi@3.6.2",
  isolation: "wasm-isolate" as const,
  host: "worker" as const,
  limits: { ...DEFAULT_FORGE_LIMITS },
};

interface FakeOptions {
  ready?: boolean;
  reason?: string;
  profiles?: string[];
}
function backend(id: PythonBackendId, options: FakeOptions = {}): PythonBackend {
  const isolation = { managed: "none", oci: "os-container", wasm: "wasm-process" } as const;
  const descriptor: EngineDescriptor = {
    id: `python-${id}`,
    language: "python",
    version: "test",
    isolation: isolation[id],
    ready: true,
    capabilities: {
      cooperativeInterrupt: false,
      hardTermination: true,
      hardMemoryLimit: id === "oci",
      networkDeniedByOS: id === "oci",
      toolCalls: false,
    },
    ...(options.profiles ? { profiles: options.profiles } : {}),
  };
  return {
    id,
    describe: async () => descriptor,
    check: async () =>
      options.ready === false
        ? { ready: false, reason: options.reason ?? `${id} is down` }
        : { ready: true },
    supports: () => ({ ok: true }),
    launch: async () => {
      throw new Error("not used");
    },
    terminate: async () => ({ confirmed: true, method: "interrupt", elapsedMs: 0 }),
  };
}

const probe = (
  backends: Partial<Record<PythonBackendId, PythonBackend>>,
  extra: {
    runtime?: "auto" | PythonBackendId;
    isolation?: "preferred" | "required" | "strict";
    extras?: string[];
    smartDashboard?: boolean;
  } = {},
) =>
  probePythonEnvironment({
    backends,
    runtime: () => extra.runtime ?? "auto",
    isolation: () => extra.isolation ?? "preferred",
    managedExtras: async () => extra.extras ?? [],
    smartDashboard: () => extra.smartDashboard ?? false,
  });

const providerFor = (python?: () => Promise<PythonEnvironment>) =>
  new GuideProvider({ javascript: async () => jsState, ...(python ? { python } : {}) });

const content = async (provider: GuideProvider, topic: string, catalog?: never[]) => {
  const answer = await provider.get({ topic, catalog });
  if (answer.unchanged) throw new Error("unexpected unchanged");
  return answer.content;
};

describe("topics and size", () => {
  it("every topic stays within 4 KiB, whatever the environment", async () => {
    const environments: PythonEnvironment[] = [
      await probe({ wasm: backend("wasm", { profiles: ["base", "analysis", "science"] }) }),
      await probe({ managed: backend("managed", { ready: false }) }),
      await probe({ oci: backend("oci") }),
    ];
    const catalog = Array.from({ length: 300 }, (_, i) => ({ name: `tool_${i}`, effect: "read" }));
    for (const env of environments) {
      const provider = providerFor(async () => env);
      for (const topic of GUIDE_TOPICS) {
        const answer = await provider.get({ topic, catalog });
        if (answer.unchanged) throw new Error("unexpected");
        expect(Buffer.byteLength(answer.content), topic).toBeLessThanOrEqual(GUIDE_MAX_BYTES);
        expect(answer.content.length).toBeGreaterThan(100);
      }
    }
  });

  it("python.* topics exist only with a Python source, js.* only with a JavaScript one", () => {
    expect(providerFor().topics()).toEqual(["js.api", "js.patterns", "js.tools"]);
    expect(
      providerFor(async () => ({ available: false, reason: "x", smartDashboard: false })).topics(),
    ).toHaveLength(8);
    expect(
      new GuideProvider({
        python: async () => ({ available: false, reason: "x", smartDashboard: false }),
      }).topics(),
    ).toEqual([
      "python.runtime",
      "python.data",
      "python.ml",
      "python.dashboards",
      "python.environment",
    ]);
  });

  it("an unavailable topic is refused with the list of the existing ones", async () => {
    await expect(providerFor().get({ topic: "python.ml" })).rejects.toBeInstanceOf(
      UnknownGuideTopicError,
    );
  });
});

describe("FJ-AC-21: etag", () => {
  it("answers unchanged, with the etag only, when ifNoneMatch equals it", async () => {
    const provider = providerFor();
    const first = await provider.get({ topic: "js.api" });
    if (first.unchanged) throw new Error("unexpected");
    expect(first.etag).toMatch(/^[0-9a-f]{16}$/);
    const again = await provider.get({ topic: "js.api", ifNoneMatch: first.etag });
    expect(again).toEqual({ unchanged: true, etag: first.etag });
    expect(JSON.stringify(again).length).toBeLessThan(60);
    const other = await provider.get({ topic: "js.api", ifNoneMatch: "0000000000000000" });
    expect(other.unchanged).toBe(false);
  });

  it("the etag follows the content: a changed limit gives another etag", async () => {
    const a = await providerFor().get({ topic: "js.api" });
    const lowered = new GuideProvider({
      javascript: async () => ({ ...jsState, limits: { ...jsState.limits, timeoutMs: 5000 } }),
    });
    const b = await lowered.get({ topic: "js.api" });
    expect(b.etag).not.toBe(a.etag);
    // A stale etag from before the change does not hide the new content.
    expect((await lowered.get({ topic: "js.api", ifNoneMatch: a.etag })).unchanged).toBe(false);
  });
});

describe("js topics", () => {
  it("js.api states the effective limits and the host", async () => {
    const text = await content(
      new GuideProvider({
        javascript: async () => ({
          ...jsState,
          host: "process",
          limits: { ...jsState.limits, maxToolCalls: 7, timeoutMs: 12_000 },
        }),
      }),
      "js.api",
    );
    expect(text).toContain("12 s");
    expect(text).toMatch(/7 per run/);
    expect(text).toContain("child process");
    expect(text).toContain("parallel.settle");
    expect(text).not.toMatch(/worker thread/);
  });

  it("js.patterns has the filtering anchor and the codePath advice", async () => {
    const text = await content(providerFor(), "js.patterns");
    expect(text).toContain("#filtering");
    expect(text).toContain("codePath");
    expect(text).toContain("parallel.map");
  });

  it("js.tools lists at most 40 entries sorted, with effects, and points at catalog.describe", async () => {
    const catalog = Array.from({ length: 70 }, (_, i) => ({
      name: `tool_${String(i).padStart(2, "0")}`,
      effect: i % 2 ? "write" : "read",
    }));
    const answer = await providerFor().get({ topic: "js.tools", catalog } as never);
    if (answer.unchanged) throw new Error("unexpected");
    const lines = answer.content.split("\n").filter((l) => l.startsWith("- tool_"));
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("- tool_00 (read)");
    expect(answer.content).toContain("30 more");
    expect(answer.content).toContain("catalog.describe");
  });

  it("js.tools changes (and its etag) with the permitted catalog", async () => {
    const provider = providerFor();
    const read = await provider.get({
      topic: "js.tools",
      catalog: [{ name: "read_file", effect: "read" }],
    });
    const both = await provider.get({
      topic: "js.tools",
      catalog: [
        { name: "read_file", effect: "read" },
        { name: "write_file", effect: "write" },
      ],
    });
    if (read.unchanged || both.unchanged) throw new Error("unexpected");
    expect(read.content).not.toContain("write_file");
    expect(both.content).toContain("write_file (write)");
    expect(read.etag).not.toBe(both.etag);
  });
});

describe("FJ-AC-22: python.environment lists only the backend the selector would choose", () => {
  it("auto prefers wasm over managed, and lists the wasm profile, not the managed extras", async () => {
    const env = await probe(
      {
        managed: backend("managed"),
        wasm: backend("wasm", { profiles: ["base", "analysis"] }),
      },
      { extras: ["science"] },
    );
    const text = await content(
      providerFor(async () => env),
      "python.environment",
    );
    expect(text).toContain("Backend that runs your next script: wasm");
    expect(text).toContain("pandas");
    expect(text).toContain("plotly");
    // scikit-learn is in the managed science extras, but wasm (the chosen one) has only `analysis`.
    expect(text).not.toMatch(/Installed:.*scikit-learn/);
    expect(text).toContain("alisio analysis setup --wasm --profile science");
    expect(text).toMatch(/NOT blocked by the OS/);
    expect(text).not.toContain("Isolation: none");
  });

  it("the guide follows the backends: with wasm down it describes managed and its extras", async () => {
    const wasm = await probe(
      {
        managed: backend("managed"),
        wasm: backend("wasm", { profiles: ["base", "analysis", "science"] }),
      },
      { extras: [] },
    );
    const managed = await probe(
      {
        managed: backend("managed"),
        wasm: backend("wasm", { ready: false, reason: "not installed" }),
      },
      { extras: ["science"] },
    );
    const a = await content(
      providerFor(async () => wasm),
      "python.environment",
    );
    const b = await content(
      providerFor(async () => managed),
      "python.environment",
    );
    expect(a).toContain("scikit-learn");
    expect(a).not.toContain("Isolation: none");
    expect(b).toContain("Backend that runs your next script: managed");
    expect(b).toContain("Isolation: none");
    expect(b).toContain("scikit-learn");
    expect(b).not.toMatch(/Pyodide profile/);
  });

  it("managed without extras says what is missing and how to get it", async () => {
    const env = await probe({ managed: backend("managed") });
    const text = await content(
      providerFor(async () => env),
      "python.environment",
    );
    expect(text).toContain("none beyond the standard library");
    expect(text).toContain("extras");
  });

  it("a container does not claim a package list", async () => {
    const env = await probe(
      { oci: backend("oci"), managed: backend("managed") },
      { extras: ["science"] },
    );
    const text = await content(
      providerFor(async () => env),
      "python.environment",
    );
    expect(text).toContain("Backend that runs your next script: oci");
    expect(text).toContain("--network=none");
    expect(text).not.toMatch(/Installed:.*pandas/);
    expect(text).toContain("container image");
  });

  it("isolation required excludes managed: with only managed ready there is a shortest fix, not a guide for managed", async () => {
    const env = await probe(
      {
        managed: backend("managed"),
        wasm: backend("wasm", { ready: false, reason: "Pyodide is not installed" }),
      },
      { isolation: "required" },
    );
    const text = await content(
      providerFor(async () => env),
      "python.environment",
    );
    expect(text).toContain("No Python backend can run a script right now");
    expect(text).toMatch(/Shortest fix: run "alisio analysis setup --wasm"/);
    expect(text).not.toContain("Isolation: none");
  });
});

describe("adaptive python topics", () => {
  it("python.ml names the profile that provides scikit-learn right now", async () => {
    const analysis = await probe({ wasm: backend("wasm", { profiles: ["base", "analysis"] }) });
    const science = await probe({
      wasm: backend("wasm", { profiles: ["base", "analysis", "science"] }),
    });
    const a = await content(
      providerFor(async () => analysis),
      "python.ml",
    );
    const b = await content(
      providerFor(async () => science),
      "python.ml",
    );
    expect(a).toMatch(/NOT available/);
    expect(a).toContain("--profile science");
    expect(b).toMatch(/scikit-learn, statsmodels and scipy are available/);
    expect(b).not.toContain("--profile science");
  });

  it("python.dashboards reflects plotly per backend and the dashboard_generate switch", async () => {
    const base = await probe({ wasm: backend("wasm", { profiles: ["base"] }) });
    const full = await probe(
      { wasm: backend("wasm", { profiles: ["base", "analysis"] }) },
      { smartDashboard: true },
    );
    const a = await content(
      providerFor(async () => base),
      "python.dashboards",
    );
    const b = await content(
      providerFor(async () => full),
      "python.dashboards",
    );
    expect(a).toMatch(/plotly is NOT available/);
    expect(a).toContain("not enabled here");
    expect(b).toMatch(/plotly is available/);
    expect(b).toContain("dashboard_generate");
    expect(b).toContain("Agg");
  });

  it("python.runtime documents the folders and the alisio_runtime API", async () => {
    const env = await probe({ managed: backend("managed") });
    const text = await content(
      providerFor(async () => env),
      "python.runtime",
    );
    for (const needle of [
      "ALISIO_OUTPUT_DIR",
      "ALISIO_SCRATCH_DIR",
      "forge.result",
      "forge.state",
      "READ-ONLY",
    ])
      expect(text).toContain(needle);
  });

  it("python.data separates data_query from python and documents datasets", async () => {
    const env = await probe({ managed: backend("managed") });
    const text = await content(
      providerFor(async () => env),
      "python.data",
    );
    expect(text).toContain("data_query");
    expect(text).toContain("datasets.open");
    expect(text).toContain("xlsx_to_sqlite");
    expect(text).toMatch(/pandas is NOT available/);
  });
});

describe("the forge_guide tool", () => {
  it("is a concurrent read tool with a short description and a dynamic enum that compiles", () => {
    const registry = new ToolRegistry();
    registerForgeGuide(registry, providerFor());
    const tool = registry.get("forge_guide");
    expect(tool.effect).toBe("read");
    expect(tool.concurrent).toBe(true);
    expect(tool.description.length).toBeLessThanOrEqual(FORGE_GUIDE_DESCRIPTION_MAX_CHARS);
    const schema = tool.inputSchema as { properties: { topic: { enum: string[] } } };
    expect(schema.properties.topic.enum).toEqual(["js.api", "js.patterns", "js.tools"]);
    expect(() => registry.parse("forge_guide", JSON.stringify({ topic: "js.api" }))).not.toThrow();
    expect(() => registry.parse("forge_guide", JSON.stringify({ topic: "python.ml" }))).toThrow();
    expect(() => registry.parse("forge_guide", JSON.stringify({}))).toThrow();
    expect(() =>
      registry.parse("forge_guide", JSON.stringify({ topic: "js.api", extra: 1 })),
    ).toThrow();
    expect(() =>
      registry.parse(
        "forge_guide",
        JSON.stringify({ topic: "js.api", ifNoneMatch: "x".repeat(65) }),
      ),
    ).toThrow();
  });

  it("offers the python topics too when python_run exists", () => {
    const registry = new ToolRegistry();
    registerForgeGuide(
      registry,
      providerFor(async () => ({ available: false, reason: "x", smartDashboard: false })),
    );
    const schema = registry.get("forge_guide").inputSchema as {
      properties: { topic: { enum: string[] } };
    };
    expect(schema.properties.topic.enum).toEqual([...GUIDE_TOPICS]);
    expect(forgeGuideDescription(GUIDE_TOPICS)).toContain("python_run");
  });

  it("registers nothing when no language has an engine", () => {
    const registry = new ToolRegistry();
    registerForgeGuide(registry, new GuideProvider({}));
    expect(registry.list()).toHaveLength(0);
  });

  it("a script can never call it", () => {
    expect(FORGE_EXCLUDED_TOOLS.has("forge_guide")).toBe(true);
  });
});

describe("hints (spec §8.4)", () => {
  it("renders a one-line pointer with the topic and the section, never the guide", () => {
    const line = renderHint({
      topic: "js.patterns#filtering",
      reason: "filter before returning",
    });
    expect(line).toContain('forge_guide topic "js.patterns"');
    expect(line).toContain("#filtering");
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(160);
  });
});
