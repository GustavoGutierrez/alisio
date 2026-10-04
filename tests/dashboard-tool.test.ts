/**
 * `dashboard_generate` (Smart Dashboard, phase 5): dataset to published artifact with no model
 * call, with and without a decision provider, plus its wiring in the application (the
 * `analysis.smartDashboard` switch, `--read-only`, provenance next to the model's).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DashboardProvenance,
  DecisionRequest,
  DecisionResponse,
  ModelProvider,
  ToolContext,
  ToolResult,
} from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataError } from "../packages/core/src/analysis/data/datasets.ts";
import { AnalysisRuntimeManager } from "../packages/core/src/analysis/runtime-manager.ts";
import { chartWarnings } from "../packages/core/src/artifacts/chart-lint.ts";
import { createArtifactPublisher } from "../packages/core/src/artifacts/publisher.ts";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import type { PublishedArtifactInfo } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { registerDashboardTools } from "../packages/core/src/tools/dashboard.ts";
import { fakeInterpreter } from "./analysis-run-helpers.ts";
import { type DataFixture, dataFixture } from "./data-helpers.ts";
import { answerFor, fakeProvider } from "./fixtures/decision-provider.ts";

const exampleCsv = (name: string) =>
  readFile(new URL(`../examples/data/${name}`, import.meta.url)).then((b) => new Uint8Array(b));
const SIMPLE = "dashboard_simple_300.csv";

const textOf = (result: ToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

// ---- the tool on its own: real dataset service and artifact store, no application ----
describe("dashboard_generate", () => {
  let fixture: DataFixture;
  let artifacts: ArtifactStore;
  let published: PublishedArtifactInfo[];
  let registry: ToolRegistry;
  let progress: string[];
  let provenances: Array<Record<string, unknown> | undefined>;

  beforeEach(async () => {
    fixture = await dataFixture();
    artifacts = new ArtifactStore({ root: fixture.root, db: fixture.store.db });
    published = [];
    progress = [];
    provenances = [];
    registry = new ToolRegistry();
    registerDashboardTools(registry, {
      datasets: fixture.service,
      rootOf: (id) => id,
    });
  });
  afterEach(async () => {
    await fixture.dispose();
  });

  function context(
    overrides: Partial<ToolContext> = {},
    options: { session?: string } = {},
  ): ToolContext {
    const session = options.session ?? "root-1";
    const publisher = createArtifactPublisher(
      artifacts,
      { sessionId: session, rootSessionId: session, workspace: fixture.root },
      (info) => published.push(info),
    );
    const original = publisher.publishTextDetailed.bind(publisher);
    publisher.publishTextDetailed = (input) => {
      provenances.push((input as { provenance?: Record<string, unknown> }).provenance);
      return original(input);
    };
    return {
      signal: new AbortController().signal,
      workspace: fixture.root,
      session,
      emit: (data) => progress.push(String(data)),
      artifacts: publisher,
      ...overrides,
    };
  }

  const tool = () => registry.get("dashboard_generate");
  const call = (input: Record<string, unknown>, ctx: ToolContext = context()) =>
    tool().execute(input, ctx);
  const ingestSimple = async (root = "root-1") =>
    (await fixture.ingest(SIMPLE, await exampleCsv(SIMPLE), { root })).record;

  it("is an internal tool with a closed input schema that tells the model when to use python_run", () => {
    expect(tool().effect).toBe("internal");
    expect(tool().description).toMatch(/python_run/);
    expect(registry.parse("dashboard_generate", '{"datasetId":"d1"}')).toEqual({
      datasetId: "d1",
    });
    expect(() => registry.parse("dashboard_generate", "{}")).toThrow();
    expect(() => registry.parse("dashboard_generate", '{"datasetId":"d","locale":"fr"}')).toThrow();
    expect(() => registry.parse("dashboard_generate", '{"datasetId":"d","extra":1}')).toThrow();
  });

  it("turns a real dataset into a published dashboard artifact with no provider", async () => {
    const record = await ingestSimple();
    const result = await call({ datasetId: record.id, goal: "sales overview" });
    expect(result.isError).toBeFalsy();

    expect(published).toHaveLength(1);
    const info = published[0] as PublishedArtifactInfo;
    expect(info.artifact.kind).toBe("dashboard");
    expect(info.artifact.fileName).toBe("dashboard.html");
    const html = await readFile(info.path, "utf8");
    expect(chartWarnings(html)).toEqual([]);
    expect(html).toContain("<figure");

    // text, then the artifact block the viewer opens
    const text = textOf(result);
    expect(text).toMatch(/^Dashboard created: .+ — \d+ KPIs?/);
    const blocks = result.content.filter((part) => part.type === "ui");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      block: { kind: "artifact", artifact: { id: info.artifact.id } },
    });

    // provenance: the generator, the spec, the planner and the notes; no decision provider
    const provenance = artifacts.list("root-1")[0]?.provenance as unknown as DashboardProvenance;
    expect(provenance).toMatchObject({
      generator: "dashboard_generate",
      planner: "rules",
      fallbacks: [],
    });
    expect(provenance.decisionProvider).toBeUndefined();
    expect(provenance.spec.version).toBe(1);
    expect(info.artifact.title).toBe(provenance.spec.title);
  });

  it("lists every shown component in a compact plan summary, without probabilities", async () => {
    const record = await ingestSimple();
    const text = textOf(await call({ datasetId: record.id }));
    const spec = (artifacts.list("root-1")[0]?.provenance as unknown as DashboardProvenance).spec;
    for (const widget of spec.widgets) {
      const name = widget.type === "kpi" ? widget.label : widget.title;
      expect(name).toBeTruthy();
      expect(text).toContain(`- ${name} (${widget.type})`);
    }
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/probabilit|confidence|\b0\.\d{2}\b/i);
    // short: a summary and a list, never the HTML
    expect(text.length).toBeLessThan(2500);
    expect(text).not.toContain("<html");
  });

  // E7b: the result must read as "finished", so the model summarizes instead of rebuilding.
  it("says the dashboard is complete and published, and where to go from here (en)", async () => {
    const record = await ingestSimple();
    const text = textOf(await call({ datasetId: record.id, goal: "sales overview" }));
    const lines = text.split("\n");
    const done = lines.find((l) => l.startsWith("Status: ")) ?? "";
    expect(done).toMatch(/complete and already published/);
    expect(done).toMatch(/short summary/);
    expect(done).toMatch(/dashboard_generate again with another goal/);
    expect(done).toMatch(/not rebuild it with python_run/);
    expect(text).not.toContain("\n- Status");
  });

  it("says the same in Spanish", async () => {
    const record = await ingestSimple();
    const text = textOf(await call({ datasetId: record.id, locale: "es" }));
    const done = text.split("\n").find((l) => l.startsWith("Estado: ")) ?? "";
    expect(done).toMatch(/completo y ya publicado/);
    expect(done).toMatch(/resumen breve/);
    expect(done).toMatch(/dashboard_generate de nuevo con otro objetivo/);
    expect(done).toMatch(/python_run/);
  });

  it("lists the measures and dimensions the dashboard actually uses", async () => {
    const record = await ingestSimple();
    const text = textOf(await call({ datasetId: record.id }));
    const spec = (artifacts.list("root-1")[0]?.provenance as unknown as DashboardProvenance).spec;
    const measures = new Set<string>();
    const dimensions = new Set<string>();
    for (const w of spec.widgets) {
      if (w.type === "kpi") {
        if (w.metric !== "*") measures.add(w.metric);
      } else if (w.type === "table") for (const c of w.columns) dimensions.add(c);
      else if (w.type === "scatter") {
        measures.add(w.x);
        measures.add(w.y);
      } else {
        if (w.metric !== "*") measures.add(w.metric);
        dimensions.add(w.dimension);
      }
    }
    const line = (prefix: string) => text.split("\n").find((l) => l.startsWith(prefix)) ?? "";
    for (const m of measures) expect(line("Measures: ")).toContain(m);
    for (const d of dimensions) expect(line("Dimensions: ")).toContain(d);
  });

  it("names the columns the goal mentions that the dashboard does not show", async () => {
    const record = await ingestSimple();
    // the analytical layout keeps a table, so the last dimension the goal names does not fit
    const goal = "analysis of sales by region, channel, salesperson, product, category and status";
    const text = textOf(await call({ datasetId: record.id, goal }));
    const spec = (artifacts.list("root-1")[0]?.provenance as unknown as DashboardProvenance).spec;
    const used = new Set(
      spec.widgets.flatMap((w) =>
        w.type === "kpi"
          ? [w.metric]
          : w.type === "table"
            ? w.columns
            : w.type === "scatter"
              ? [w.x, w.y]
              : [w.dimension, w.metric],
      ),
    );
    const named = ["region", "channel", "salesperson", "product", "category", "status"];
    const missing = named.filter((c) => !used.has(c));
    const line = text.split("\n").find((l) => l.startsWith("Not shown: ")) ?? "";
    expect(missing.length).toBeGreaterThan(0);
    for (const c of missing) expect(line).toContain(c);
    for (const c of named.filter((n) => used.has(n))) expect(line).not.toContain(c);
    // the standing instruction is part of the line
    expect(line).toMatch(/say so in your summary/);
  });

  it("plans for the columns a long, specific goal names and keeps the goal out of the queries", async () => {
    const record = await ingestSimple();
    const goal = "executive view of sales by category, seller and status";
    const text = textOf(await call({ datasetId: record.id, goal }));
    const spec = (artifacts.list("root-1")[0]?.provenance as unknown as DashboardProvenance).spec;
    const dims = spec.widgets.flatMap((w) =>
      w.type === "kpi" || w.type === "scatter" || w.type === "table" ? [] : [w.dimension],
    );
    for (const d of ["category", "salesperson", "status"]) expect(dims).toContain(d);
    expect(text).not.toContain("Not shown:");
  });

  it("accepts a goal over 2000 characters: it is truncated with a note, not rejected", async () => {
    const record = await ingestSimple();
    const goal = `sales by category ${"and more words ".repeat(250)}`;
    expect(goal.length).toBeGreaterThan(2000);
    expect(() =>
      registry.parse("dashboard_generate", JSON.stringify({ datasetId: record.id, goal })),
    ).not.toThrow();
    const result = await call({ datasetId: record.id, goal });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/Notes: .*goal.*2000/);
  });

  it("sends at most the first 500 characters of the goal to the decision provider", async () => {
    const record = await ingestSimple();
    const fake = withDecisions(async () => null);
    const goal = `sales overview ${"x".repeat(1200)}`;
    await call({ datasetId: record.id, goal }, context({ decisions: fake.decisions }));
    const state = fake.requests[0]?.state as { goal: string };
    expect(state.goal).toHaveLength(500);
  });

  it("has no 'Not shown' line when the goal names nothing missing", async () => {
    const record = await ingestSimple();
    const text = textOf(await call({ datasetId: record.id, goal: "a general overview" }));
    expect(text).not.toContain("Not shown:");
  });

  it("keeps internal decision notes out of the model-visible text, but in provenance", async () => {
    const record = await ingestSimple();
    const fake = withDecisions(async () => null);
    const text = textOf(
      await call({ datasetId: record.id }, context({ decisions: fake.decisions })),
    );
    expect(text).not.toMatch(/decisions:|no usable answer/);
    expect(provenanceOf().fallbacks.join(" ")).toMatch(/no usable answer/);
  });

  it("honors title and locale (templates, never a model)", async () => {
    const record = await ingestSimple();
    const es = textOf(
      await call({ datasetId: record.id, locale: "es", title: "Ventas de prueba" }),
    );
    expect(es).toMatch(/^Dashboard creado: Ventas de prueba — /);
    const info = published.at(-1) as PublishedArtifactInfo;
    expect(info.artifact.title).toBe("Ventas de prueba");
    expect(await readFile(info.path, "utf8")).toContain('<html lang="es"');

    const en = textOf(await call({ datasetId: record.id, locale: "en" }));
    expect(en).toMatch(/^Dashboard created: /);
    expect(await readFile((published.at(-1) as PublishedArtifactInfo).path, "utf8")).toContain(
      '<html lang="en"',
    );
  });

  it("is deterministic: the same dataset and goal give the same spec hash", async () => {
    const record = await ingestSimple();
    await call({ datasetId: record.id, goal: "overview" });
    await call({ datasetId: record.id, goal: "overview" });
    const hashes = provenances.map((p) =>
      createHash("sha256")
        .update(JSON.stringify((p as unknown as DashboardProvenance).spec))
        .digest("hex"),
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("emits the progress lines in order", async () => {
    const record = await ingestSimple();
    await call({ datasetId: record.id });
    const lines = progress.join("").split("\n").filter(Boolean);
    expect(lines[0]).toBe("Analyzing dataset…");
    expect(lines[1]).toBe("Planning dashboard…");
    expect(lines[2]).toMatch(/^Building \d+ components…$/);
    const queries = lines.filter((l) => l.startsWith("Query "));
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]).toMatch(/^Query 1\/\d+…$/);
    const last = queries.at(-1) as string;
    const [, done, total] = /^Query (\d+)\/(\d+)…$/.exec(last) ?? [];
    expect(done).toBe(total);
    expect(lines.at(-1)).toBe("Dashboard ready");
    expect(lines.indexOf(queries[0] as string)).toBeGreaterThan(2);
    expect(lines.indexOf("Dashboard ready")).toBeGreaterThan(lines.indexOf(last));
    // every chunk is one line the web queue and the TUI can show on its own
    for (const chunk of progress) expect(chunk.endsWith("\n")).toBe(true);
  });

  it("fails clearly on an unknown dataset and on another session's dataset", async () => {
    await expect(call({ datasetId: "nope" })).rejects.toThrow(/dataset_not_found/);
    const foreign = await ingestSimple("other-root");
    await expect(call({ datasetId: foreign.id })).rejects.toThrow(/dataset_not_found/);
    expect(published).toEqual([]);
  });

  it("selects the sheet by name and rejects an unknown one, listing the real ones", async () => {
    const record = await ingestSimple();
    await expect(call({ datasetId: record.id, sheet: "data" })).resolves.toMatchObject({});
    const error = await call({ datasetId: record.id, sheet: "Nope" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Unknown sheet/);
    expect((error as Error).message).toContain("data");
  });

  it("tells the model to use python_run when nothing in the dataset can be planned", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => `row-${String(i).padStart(4, "0")}`);
    const { record } = await fixture.ingest("ids.csv", `id\n${rows.join("\n")}\n`);
    const before = published.length;
    const error = (await call({ datasetId: record.id }).catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^no_usable_columns:/);
    expect(error.message).toMatch(/python_run/);
    expect(published).toHaveLength(before);
  });

  it("a failing query step leaves no partial artifact", async () => {
    const record = await ingestSimple();
    const broken = Object.create(fixture.service) as typeof fixture.service;
    broken.query = async () => {
      throw new DataError("query_timeout", "too slow");
    };
    const reg = new ToolRegistry();
    registerDashboardTools(reg, { datasets: broken, rootOf: (id) => id });
    const error = (await reg
      .get("dashboard_generate")
      .execute({ datasetId: record.id }, context())
      .catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/^query_failed:/);
    expect(error.message).toMatch(/python_run/);
    expect(published).toEqual([]);
    expect(artifacts.list("root-1")).toEqual([]);
  });

  it("stops on cancellation, before or during the work, without publishing", async () => {
    const record = await ingestSimple();
    const early = new AbortController();
    early.abort();
    await expect(
      call({ datasetId: record.id }, context({ signal: early.signal })),
    ).rejects.toThrow();

    const late = new AbortController();
    const ctx = context({
      signal: late.signal,
      emit: (data) => {
        progress.push(String(data));
        if (String(data).startsWith("Planning")) late.abort();
      },
    });
    await expect(call({ datasetId: record.id }, ctx)).rejects.toThrow();
    expect(published).toEqual([]);
    expect(progress.join("")).not.toContain("Dashboard ready");
  });

  it("is not available where there is no artifact store (code mode)", async () => {
    const record = await ingestSimple();
    await expect(
      call({ datasetId: record.id }, context({ artifacts: undefined as never })),
    ).rejects.toThrow(/Artifacts are not available here/);
  });

  // ---- with a decision provider (the double answers like the service would) ----
  const respond = (
    request: DecisionRequest,
    pick: (keys: string[]) => { use: string[]; reject: string[] },
  ): DecisionResponse => {
    const keys = Object.keys(request.decisions);
    const { use, reject } = pick(keys);
    return {
      provider: "fake-provider",
      latencyMs: 2,
      decisions: Object.fromEntries(
        use.map((key) => [key, answerFor(request.decisions[key] as never)]),
      ),
      rejected: Object.fromEntries(reject.map((key) => [key, "invalid" as const])),
    };
  };
  const withDecisions = (
    answer: (request: DecisionRequest) => Promise<DecisionResponse | null>,
  ) => {
    const requests: DecisionRequest[] = [];
    return {
      requests,
      decisions: {
        available: () => true,
        activeProvider: () => ({ id: "fake-provider", name: "Fake provider" }),
        tryDecide: vi.fn(async (request: DecisionRequest) => {
          requests.push(request);
          return answer(request);
        }),
      },
    };
  };
  const provenanceOf = () =>
    artifacts.list("root-1").at(-1)?.provenance as unknown as DashboardProvenance;

  it("a provider that answers everything is recorded as decisionProvider", async () => {
    const record = await ingestSimple();
    const fake = withDecisions(async (r) => respond(r, (keys) => ({ use: keys, reject: [] })));
    const result = await call({ datasetId: record.id }, context({ decisions: fake.decisions }));
    expect(result.isError).toBeFalsy();
    expect(fake.requests).toHaveLength(1);
    expect(provenanceOf()).toMatchObject({
      generator: "dashboard_generate",
      planner: "rules+decisions",
      decisionProvider: "fake-provider",
    });
    expect(published.at(-1)?.artifact.kind).toBe("dashboard");
  });

  it("a rejected answer still produces a valid dashboard and notes the rejected key", async () => {
    const record = await ingestSimple();
    const fake = withDecisions(async (r) => respond(r, (keys) => ({ use: [], reject: keys })));
    await call({ datasetId: record.id }, context({ decisions: fake.decisions }));
    const provenance = provenanceOf();
    expect(provenance.fallbacks.join(" ")).toMatch(/rejected/);
    expect(published).toHaveLength(1);
  });

  it("every answer rejected, a null answer or a throwing provider: the rule dashboard", async () => {
    const record = await ingestSimple();
    const baseline = await call({ datasetId: record.id });
    const baselineSpec = provenanceOf().spec;
    for (const answer of [
      async (r: DecisionRequest) => respond(r, (keys) => ({ use: [], reject: keys })),
      async () => null,
      async () => {
        throw new Error("provider exploded");
      },
    ]) {
      const fake = withDecisions(answer);
      const result = await call({ datasetId: record.id }, context({ decisions: fake.decisions }));
      expect(result.isError).toBeFalsy();
      const provenance = provenanceOf();
      expect(provenance.planner).toBe("rules");
      expect(provenance.decisionProvider).toBeUndefined();
      expect(provenance.spec).toEqual(baselineSpec);
      const components = (text: string) =>
        text.split("\n").filter((line) => line.startsWith("- ") || line.startsWith("Dashboard"));
      expect(components(textOf(result))).toEqual(components(textOf(baseline)));
    }
  });

  it("never sends cell values to the provider (only the goal and column metadata)", async () => {
    const sentinel = "ZEBRA-SENTINEL-77";
    const csv = `region,amount\n${Array.from({ length: 30 }, (_, i) => `${sentinel}-${i % 3},${i + 1}`).join("\n")}\n`;
    const { record } = await fixture.ingest("sentinel.csv", csv);
    const fake = withDecisions(async () => null);
    await call({ datasetId: record.id, goal: "totals" }, context({ decisions: fake.decisions }));
    expect(JSON.stringify(fake.requests)).not.toContain(sentinel);
  });
});

// ---- wired in the application ----
describe("dashboard_generate in the application", () => {
  let root: string;
  let workspace: string;
  const apps: Array<{ close(): Promise<void> }> = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "alisio-dashboard-app-"));
    workspace = join(root, "ws");
    await mkdir(join(workspace, ".alisio"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const silent: ModelProvider = {
    id: "fake-provider",
    model: "fake-model",
    async *stream() {
      yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
    },
  };
  async function app(options: Parameters<typeof createApplication>[0] = {}) {
    const manager = Object.assign(new AnalysisRuntimeManager({ stateDir: join(root, "state") }), {
      interpreter: fakeInterpreter,
    });
    const created = await createApplication({
      cwd: workspace,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: silent,
      analysisRuntime: manager,
      allowAnalysis: true,
      ...options,
    });
    apps.push(created);
    return created;
  }
  const setConfig = (value: unknown) =>
    writeFile(join(root, "config", "config.json"), JSON.stringify(value));
  const names = (a: Awaited<ReturnType<typeof app>>) => a.registry.list().map((t) => t.name);
  const describe_ = (a: Awaited<ReturnType<typeof app>>, name: string) =>
    a.registry.list().find((t) => t.name === name)?.description ?? "";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("is registered by default, next to the other analysis tools", async () => {
    const a = await app();
    expect(a.config.analysis.smartDashboard).toBe(true);
    expect(names(a)).toContain("dashboard_generate");
    expect(names(a)).toContain("artifact_create");
  });

  it("is absent with --read-only and with analysis.enabled false (as artifact_create)", async () => {
    const readOnly = await app({ readOnly: true });
    expect(names(readOnly)).not.toContain("dashboard_generate");
    expect(names(readOnly)).not.toContain("artifact_create");
    await setConfig({ analysis: { enabled: false } });
    const off = await app();
    expect(names(off)).not.toContain("dashboard_generate");
  });

  it("analysis.smartDashboard false: not registered, and the model guidance is untouched", async () => {
    const on = await app();
    await setConfig({ analysis: { smartDashboard: false } });
    const off = await app();
    expect(off.config.analysis.smartDashboard).toBe(false);
    expect(names(off)).not.toContain("dashboard_generate");
    expect(names(off)).toContain("python_run");
    expect(names(off)).toContain("artifact_create");
    for (const name of ["python_run", "artifact_create", "data_inspect", "data_query"]) {
      const text = describe_(off, name);
      expect(text).not.toContain("dashboard_generate");
      // the `true` state differs (Fase 6); the `false` state is pinned byte for byte below
      expect(describe_(on, name)).toContain("dashboard_generate");
    }
  });

  // Pinned digests of the guidance strings as they are in 0.3.0 (the `false` state must keep
  // them forever; phase 6 only changes the `true` state).
  it("analysis.smartDashboard false keeps the 0.3.0 guidance byte for byte", async () => {
    await setConfig({ analysis: { smartDashboard: false } });
    const off = await app();
    const digests = Object.fromEntries(
      ["python_run", "artifact_create", "data_inspect", "data_query"].map((name) => [
        name,
        sha(describe_(off, name)),
      ]),
    );
    expect(digests).toEqual(GUIDANCE_DIGESTS);
  });

  // Fase 6 (spec §10.1): with `true` the model is steered to dashboard_generate; python_run stays
  // for what the catalog does not cover.
  it("analysis.smartDashboard true steers the tool descriptions to dashboard_generate", async () => {
    const on = await app();
    const python = describe_(on, "python_run");
    expect(python).toContain("prefer dashboard_generate (no code)");
    expect(python).toContain(
      "Use python_run for analysis or visuals the dashboard catalog does not cover (statistical tests, custom or unsupported charts, joins, exports)",
    );
    expect(python).toContain("alisio_runtime offers output_dir()");
    // E7: the long charts paragraph is gone, the helper names stay as a pointer
    expect(python).not.toContain("charts (Chart.js bundled");
    expect(python).not.toContain("pie only for 2-5 parts");
    expect(python).toContain("charts.card/grid/kpis/write");
    expect(python).toContain("svg.*");
    expect(python).toContain("beyond dashboard_generate's catalog");
    expect(python).toContain("inputs: [{ datasetId }] copies a dataset");
    expect(describe_(on, "data_inspect")).toContain(
      "python_run { inputs: [{ datasetId }] } or dashboard_generate { datasetId }",
    );
    expect(describe_(on, "data_query")).toContain(
      "Heavy analysis belongs in python_run. A dashboard of a dataset: dashboard_generate.",
    );
    expect(describe_(on, "artifact_create")).toContain(
      "For a data dashboard use dashboard_generate instead of writing the HTML.",
    );
    expect(
      describe_(on, "dashboard_generate").startsWith(
        "Use this first whenever the user asks for a dashboard of a dataset.",
      ),
    ).toBe(true);
  });

  // E7 (spec §14.1.1): the system prompt names the tool only while the switch is on.
  it("the system prompt carries the dashboard_generate rule only with analysis and the switch on", async () => {
    const seen: string[] = [];
    const spy: ModelProvider = {
      id: "fake-provider",
      model: "fake-model",
      async *stream(request) {
        seen.push(request.instructions);
        yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
      },
    };
    const promptOf = async (config: unknown) => {
      await setConfig(config);
      const a = await app({ provider: spy });
      const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
      await a.runner.run(session, "hi");
      return seen.at(-1) ?? "";
    };
    const rule = "call dashboard_generate first with the dataset id and the user's goal";
    const on = await promptOf({ analysis: { smartDashboard: true } });
    expect(on).toContain(rule);
    expect(on).toContain("Use python_run only if dashboard_generate returns an error");
    const off = await promptOf({ analysis: { smartDashboard: false } });
    expect(off).not.toContain("dashboard_generate");
    const disabled = await promptOf({ analysis: { enabled: false } });
    expect(disabled).not.toContain("dashboard_generate");
  });

  it("the dataset description and the attached-dataset summary mention dashboard_generate only when true", async () => {
    const file = join(workspace, "sales.csv");
    await writeFile(file, await exampleCsv(SIMPLE));
    const texts: Record<string, { describe: string; summary: string }> = {};
    for (const smart of [true, false]) {
      await setConfig({ analysis: { smartDashboard: smart } });
      const a = await app();
      const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
      const { record } = await a.datasets.ingest({
        rootSessionId: session,
        sessionId: session,
        workspace: a.workspace,
        path: file,
      });
      texts[String(smart)] = {
        describe: (await a.datasets.describe(record, 3, 8000)).text,
        summary: await a.datasets.summary(record),
      };
    }
    for (const kind of ["describe", "summary"] as const) {
      expect(texts.true?.[kind]).toContain(
        "For a dashboard use dashboard_generate { datasetId, goal }.",
      );
      expect(texts.true?.[kind]).toContain("pass { datasetId } to python_run");
      expect(texts.false?.[kind]).not.toContain("dashboard_generate");
    }
  });

  it("publishes through the run: the provenance keeps the model's provider next to decisionProvider", async () => {
    await setConfig({ decisions: { enabled: true, provider: "fake-provider" } });
    const a = await app();
    a.decisions.registry.register("test", fakeProvider({ id: "fake-provider" }));
    a.decisions.service.syncActive();
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    const file = join(workspace, "sales.csv");
    await writeFile(file, await exampleCsv(SIMPLE));
    const { record } = await a.datasets.ingest({
      rootSessionId: session,
      sessionId: session,
      workspace: a.workspace,
      path: file,
    });
    const { result } = await a.runner.runToolCall(session, "dashboard_generate", {
      datasetId: record.id,
      goal: "sales overview",
    });
    expect(result.isError).toBeFalsy();
    const [artifact] = a.artifacts.list(session);
    expect(artifact?.kind).toBe("dashboard");
    expect(artifact?.provenance).toMatchObject({
      model: "fake-model",
      provider: "fake-provider",
      generator: "dashboard_generate",
      planner: "rules+decisions",
      decisionProvider: "fake-provider",
    });
    const manifest = await readFile(
      join(a.artifacts.folder(artifact as never), "manifest.json"),
      "utf8",
    );
    expect(manifest).not.toContain(root);
  });

  it("works with no decision provider configured", async () => {
    const a = await app();
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    const file = join(workspace, "sales.csv");
    await writeFile(file, await exampleCsv(SIMPLE));
    const { record } = await a.datasets.ingest({
      rootSessionId: session,
      sessionId: session,
      workspace: a.workspace,
      path: file,
    });
    const { result } = await a.runner.runToolCall(session, "dashboard_generate", {
      datasetId: record.id,
    });
    expect(result.isError).toBeFalsy();
    expect(a.artifacts.list(session)[0]?.provenance).toMatchObject({ planner: "rules" });
  });
});

const GUIDANCE_DIGESTS: Record<string, string> = {
  artifact_create: "52bbd2d38146b732b74d5cfd238434dba39efa6c36323198604fc78d312cc1f8",
  data_inspect: "f0f4de4d4b3f98b09c923ba5d8ad0269a51407608aebf46106981ac3be3c52ca",
  data_query: "94c3b3ef4cbf8d0a179f7de09b3f5aba02a1c9334d27c0567d339acd5b219c59",
  python_run: "2e2828eee7b534c8f3ec92f6a30979714cde5f992260164c8a18a96c1be36fce",
};
