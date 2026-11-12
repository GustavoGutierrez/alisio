/** Plugin creator web logic: badges, steps, request checks, failures, files, schema diagram, strings. */
import type {
  PluginCreatorBuildResponse,
  PluginCreatorProjectEntry,
  PluginCreatorSchema,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  creatorFailure,
  displayVersion,
  fileTree,
  formatDuration,
  installBlock,
  isRunActive,
  issueKey,
  lastBuildFailure,
  REQUEST_MAX,
  requestProblem,
  schemaLayout,
  shareCommands,
  statusBadge,
  stepsView,
} from "../packages/web/src/components/creator/model.ts";
import { creatorStrings } from "../packages/web/src/components/creator/strings.ts";
import { ApiRequestError } from "../packages/web/src/net/api.ts";
import {
  activeAppKey,
  creatorOpen,
  creatorSession,
} from "../packages/web/src/store/plugin-apps-state.ts";

const entry = (
  status: Partial<PluginCreatorProjectEntry["status"]> = {},
  project: Partial<PluginCreatorProjectEntry["project"]> = {},
): PluginCreatorProjectEntry => ({
  project: {
    id: "abcdefabcdef",
    packageName: "alisio-plugin-local-words-abcd",
    pluginId: "local.words-abcd",
    displayName: "Words",
    description: "Counts words",
    version: "1.0.0",
    createdAt: 1,
    updatedAt: 1,
    requests: [],
    ...project,
  },
  status: {
    installed: false,
    local: false,
    projectVersion: "1.0.0",
    updateAvailable: false,
    packageReady: false,
    ...status,
  },
});

describe("statusBadge", () => {
  it("shows building while a run is active, then update, installed or not installed", () => {
    expect(statusBadge(entry({ installed: true }), true)).toBe("building");
    expect(statusBadge(entry({ installed: true, updateAvailable: true }), false)).toBe("update");
    expect(statusBadge(entry({ installed: true }), false)).toBe("installed");
    expect(statusBadge(entry(), false)).toBe("notInstalled");
  });
});

describe("statusBadge: a plugin that does not start", () => {
  it("shows failed when the installed plugin could not start", () => {
    expect(
      statusBadge(entry({ installed: true, activationError: "Activation failed" }), false),
    ).toBe("failed");
  });
});

describe("installBlock", () => {
  it("allows installing only a package that passed every gate for the current sources", () => {
    expect(installBlock(entry({ packageReady: false }))).toBe("installNeedsBuild");
    expect(installBlock(entry({ packageReady: true }))).toBeUndefined();
  });
});

describe("lastBuildFailure", () => {
  it("explains a failed build of an earlier visit, and says when Alisio gave up", () => {
    const failedBuild = {
      at: 1,
      ok: false,
      durationMs: 1,
      files: 1,
      bytes: 1,
      testsPassed: 0,
      testsFailed: 0,
      version: "1.0.0",
      errorCode: "plugin_project_invalid",
      issues: [{ code: "activation_failed", severity: "error" as const, message: "strict mode" }],
    };
    expect(lastBuildFailure(entry({}, { lastBuild: failedBuild, failedBuilds: 1 }))).toEqual({
      gaveUp: false,
      issues: failedBuild.issues,
    });
    expect(lastBuildFailure(entry({}, { lastBuild: failedBuild, failedBuilds: 3 }))?.gaveUp).toBe(
      true,
    );
    expect(
      lastBuildFailure(entry({}, { lastBuild: { ...failedBuild, ok: true } })),
    ).toBeUndefined();
  });
});

describe("displayVersion", () => {
  it("shows the project version (what the next install ships)", () => {
    expect(displayVersion(entry({ installed: true, installedVersion: "1.0.0" }))).toBe("1.0.0");
    expect(
      displayVersion(
        entry(
          { installed: true, installedVersion: "1.0.0", updateAvailable: true },
          { version: "1.0.1" },
        ),
      ),
    ).toBe("1.0.1");
  });
});

describe("stepsView", () => {
  it("always lists the five steps in order, filling missing ones as pending", () => {
    const view = stepsView([
      { id: "code", status: "running", note: "Writing it" },
      { id: "plan", status: "done" },
    ]);
    expect(view.map((s) => s.id)).toEqual(["plan", "tests", "code", "run_tests", "package"]);
    expect(view.map((s) => s.status)).toEqual(["done", "pending", "running", "pending", "pending"]);
    expect(view[2]?.note).toBe("Writing it");
    expect(stepsView(undefined).every((s) => s.status === "pending")).toBe(true);
  });

  it("never shows a running step when no run is active (legacy records included)", () => {
    // The record of an older build: plan stayed "running" after every later step was done.
    const legacy = [
      { id: "plan" as const, status: "running" as const, note: "Planning" },
      { id: "tests" as const, status: "done" as const },
      { id: "code" as const, status: "done" as const },
      { id: "run_tests" as const, status: "done" as const },
      { id: "package" as const, status: "done" as const },
    ];
    expect(stepsView(legacy, { active: false }).map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(stepsView(legacy, { active: true })[0]?.status).toBe("running");
    const stopped = [{ id: "code" as const, status: "running" as const }];
    expect(stepsView(stopped, { active: false })[2]?.status).toBe("failed");
    expect(stepsView(stopped, { active: false, packaged: true })[2]?.status).toBe("done");
  });
});

describe("isRunActive", () => {
  it("is active while the session is queued, runs or waits for the person", () => {
    expect(isRunActive("running")).toBe(true);
    expect(isRunActive("queued")).toBe(true);
    expect(isRunActive("awaiting_input")).toBe(true);
    expect(isRunActive("idle")).toBe(false);
    expect(isRunActive("error")).toBe(false);
    expect(isRunActive(undefined)).toBe(false);
  });
});

describe("requestProblem", () => {
  it("rejects empty and too long requests", () => {
    expect(requestProblem("   ")).toBe("empty");
    expect(requestProblem("x".repeat(REQUEST_MAX + 1))).toBe("tooLong");
    expect(requestProblem("Track monthly expenses")).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("uses milliseconds, seconds and minutes", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(12_400)).toBe("12 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(120_000)).toBe("2 min");
  });
});

describe("issueKey", () => {
  it("maps stable build codes to localized keys and unknown ones to undefined", () => {
    const { issuesEn, issuesEs } = creatorStrings;
    for (const code of ["sdk_incompatible", "svg_unsafe", "tests_missing", "forbidden_import"])
      expect(issueKey(code), code).toBe(code);
    for (const code of [
      "activation_failed",
      "syntax_error",
      "typescript_source",
      "import_not_packed",
      "tool_smoke_failed",
      "dispose_failed",
      "reactivate_failed",
      "tool_untested",
      "tests_too_few",
      "gate_unavailable",
    ])
      expect(issueKey(code), code).toBe(code);
    expect(issueKey("brand_new_code")).toBeUndefined();
    expect(Object.keys(issuesEs).sort()).toEqual(Object.keys(issuesEn).sort());
  });
});

const buildBody = (over: Partial<PluginCreatorBuildResponse> = {}): PluginCreatorBuildResponse => ({
  ok: false,
  build: {
    at: 1,
    ok: false,
    durationMs: 10,
    files: 3,
    bytes: 100,
    testsPassed: 1,
    testsFailed: 2,
    version: "1.0.0",
  },
  issues: [{ code: "svg_unsafe", severity: "error", message: "bad svg", file: "assets/icon.svg" }],
  project: entry().project,
  status: entry().status,
  ...over,
});

describe("creatorFailure", () => {
  it("reads build failures out of the 422 details", () => {
    const tests = creatorFailure(
      new ApiRequestError(422, "plugin_tests_failed", "failed", buildBody()),
    );
    expect(tests).toMatchObject({ kind: "tests", failed: 2, passed: 1 });
    const invalid = creatorFailure(
      new ApiRequestError(422, "plugin_project_invalid", "invalid", buildBody()),
    );
    expect(invalid.kind).toBe("invalid");
    expect(invalid.issues?.map((i) => i.code)).toEqual(["svg_unsafe"]);
  });
  it("names busy, read-only, missing model, not found and other errors", () => {
    expect(creatorFailure(new ApiRequestError(409, "plugin_project_busy", "x")).kind).toBe("busy");
    expect(creatorFailure(new ApiRequestError(403, "capability_ceiling", "x")).kind).toBe(
      "readOnly",
    );
    expect(
      creatorFailure(new ApiRequestError(400, "validation_failed", "x", { fields: ["model"] }))
        .kind,
    ).toBe("model");
    expect(creatorFailure(new ApiRequestError(404, "plugin_project_not_found", "x")).kind).toBe(
      "notFound",
    );
    expect(creatorFailure(new ApiRequestError(409, "plugin_not_built", "x")).kind).toBe("notBuilt");
    expect(creatorFailure(new Error("boom"))).toEqual({ kind: "other", message: "boom" });
  });
});

describe("fileTree", () => {
  it("lists folders before files, nested and sorted, with folder rows once", () => {
    const rows = fileTree([
      { path: "src/index.js", bytes: 10 },
      { path: "package.json", bytes: 5 },
      { path: "test/index.test.js", bytes: 7 },
      { path: "src/lib/util.js", bytes: 3 },
    ]);
    expect(rows.map((r) => `${r.depth}:${r.kind}:${r.name}`)).toEqual([
      "0:dir:src",
      "1:dir:lib",
      "2:file:util.js",
      "1:file:index.js",
      "0:dir:test",
      "1:file:index.test.js",
      "0:file:package.json",
    ]);
    expect(rows.find((r) => r.name === "util.js")?.path).toBe("src/lib/util.js");
  });
});

const schema: PluginCreatorSchema = {
  tables: [
    {
      name: "notebooks",
      columns: [
        { name: "id", type: "INTEGER", pk: true, notNull: true },
        { name: "title", type: "TEXT", pk: false, notNull: true },
      ],
    },
    {
      name: "notes",
      columns: [
        { name: "id", type: "INTEGER", pk: true, notNull: true },
        {
          name: "notebook_id",
          type: "INTEGER",
          pk: false,
          notNull: false,
          fk: { table: "notebooks", column: "id" },
        },
        { name: "orphan", type: "INTEGER", pk: false, notNull: false, fk: { table: "missing" } },
      ],
    },
  ],
};

describe("schemaLayout", () => {
  it("places tables without overlap and draws one line per resolvable foreign key", () => {
    const layout = schemaLayout(schema);
    expect(layout.tables).toHaveLength(2);
    const [a, b] = layout.tables;
    if (!a || !b) throw new Error("missing tables");
    const overlap =
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlap).toBe(false);
    expect(layout.width).toBeGreaterThanOrEqual(Math.max(a.x + a.width, b.x + b.width));
    expect(layout.height).toBeGreaterThanOrEqual(Math.max(a.y + a.height, b.y + b.height));
    // The FK to a missing table draws no line.
    expect(layout.links).toHaveLength(1);
    expect(layout.links[0]).toMatchObject({ from: "notes.notebook_id", to: "notebooks.id" });
    expect(layout.links[0]?.path.startsWith("M")).toBe(true);
  });
  it("keeps every connector inside the canvas, also between stacked tables", () => {
    const stacked: PluginCreatorSchema = {
      tables: [
        { name: "a", columns: [{ name: "id", type: "INTEGER", pk: true, notNull: true }] },
        { name: "b", columns: [{ name: "id", type: "INTEGER", pk: true, notNull: true }] },
        {
          name: "c",
          columns: [
            { name: "a_id", type: "INTEGER", pk: false, notNull: false, fk: { table: "a" } },
            { name: "self", type: "INTEGER", pk: false, notNull: false, fk: { table: "c" } },
          ],
        },
      ],
    };
    const layout = schemaLayout(stacked);
    expect(layout.links).toHaveLength(2);
    for (const link of layout.links) {
      const xs = [...link.path.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
      for (const x of xs) {
        expect(x, link.path).toBeGreaterThanOrEqual(0);
        expect(x, link.path).toBeLessThanOrEqual(layout.width);
      }
    }
  });
  it("returns an empty diagram for no tables", () => {
    expect(schemaLayout({ tables: [] })).toMatchObject({ tables: [], links: [] });
  });
});

describe("shareCommands", () => {
  it("quotes the folder for the shell and keeps npm commands fixed", () => {
    const cmds = shareCommands("/home/ana/My plugins/abc");
    expect(cmds.cd).toBe('cd "/home/ana/My plugins/abc"');
    expect(cmds.login).toBe("npm login");
    expect(cmds.publish).toBe("npm publish --access public");
    expect(cmds.bump).toBe("npm version patch");
    expect(shareCommands('C:\\Users\\a"b').cd).toBe('cd "C:\\Users\\a\\"b"');
  });
});

describe("creator signals", () => {
  it("live in the leaf state module with the app key", () => {
    expect(creatorOpen.value).toBe(false);
    expect(creatorSession.value).toBeUndefined();
    expect(activeAppKey.value).toBeUndefined();
  });
});

describe("strings", () => {
  it("English and Spanish have the same keys and placeholders", () => {
    const { en, es, issuesEn, issuesEs } = creatorStrings;
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>)
      expect(holes(es[key]), key).toEqual(holes(en[key]));
    for (const key of Object.keys(issuesEn) as Array<keyof typeof issuesEn>)
      expect(holes(issuesEs[key]), key).toEqual(holes(issuesEn[key]));
  });
});
