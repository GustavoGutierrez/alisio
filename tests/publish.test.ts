import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bumpVersions,
  manifestProblems,
  PUBLISH_ORDER,
  parsePublishArgs,
  planPublish,
  publishOrder,
  tarballName,
} from "../scripts/publish.ts";

const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;

describe("publish script: ordering", () => {
  it("orders sdk before core before cli regardless of input order", () => {
    expect(publishOrder(["cli", "core", "sdk"])).toEqual(["sdk", "core", "cli"]);
    expect(publishOrder(["cli", "sdk"])).toEqual(["sdk", "cli"]);
  });

  it("deduplicates and keeps core before plugins and cli last in the full order", () => {
    const order = publishOrder([...PUBLISH_ORDER, "cli"]);
    expect(order).toEqual(PUBLISH_ORDER);
    expect(order[0]).toBe("sdk");
    expect(order[1]).toBe("core");
    expect(order.indexOf("cli")).toBe(order.length - 1);
    for (const plugin of ["plugin-deepseek", "plugin-memory", "plugin-opencode"])
      expect(order.indexOf(plugin)).toBeGreaterThan(order.indexOf("core"));
    expect(order.indexOf("cli")).toBeGreaterThan(order.indexOf("plugin-opencode-go"));
  });
});

describe("publish script: leak check", () => {
  it("rejects a manifest that leaks the workspace protocol", () => {
    const problems = manifestProblems({
      name: "@alisio/core",
      version: "1.0.0",
      dependencies: { "@alisio/sdk": "workspace:*" },
    });
    expect(problems.some((p) => p.includes("workspace:"))).toBe(true);
  });

  it("rejects source exports (alisio-source and ./src/)", () => {
    expect(
      manifestProblems({ exports: { ".": { import: "./src/index.ts" } } }).some((p) =>
        p.includes("source export"),
      ),
    ).toBe(true);
    expect(
      manifestProblems({
        exports: {
          ".": { import: "./dist/index.js", "alisio-source": { import: "./src/index.ts" } },
        },
      }).some((p) => p.includes("source export")),
    ).toBe(true);
  });

  it("rejects exports that do not point at dist/ and private manifests", () => {
    expect(
      manifestProblems({ exports: { ".": { import: "./lib/index.js" } } }).some((p) =>
        p.includes("dist"),
      ),
    ).toBe(true);
    expect(manifestProblems({ private: true }).some((p) => p.includes("private"))).toBe(true);
  });

  it("accepts a clean publishable manifest", () => {
    expect(
      manifestProblems({
        name: "@alisio/sdk",
        version: "1.0.0",
        exports: { ".": { import: "./dist/index.js" } },
      }),
    ).toEqual([]);
  });
});

describe("publish script: dry-run has no side effects", () => {
  it("builds a plan without touching files", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-publish-plan-"));
    try {
      mkdirSync(join(root, "packages", "sdk"), { recursive: true });
      mkdirSync(join(root, "packages", "cli"), { recursive: true });
      mkdirSync(join(root, "packages", "core"), { recursive: true });
      const files = {
        sdk: join(root, "packages", "sdk", "package.json"),
        core: join(root, "packages", "core", "package.json"),
        cli: join(root, "packages", "cli", "package.json"),
      };
      writeFileSync(files.sdk, pkg("@alisio/sdk", "1.0.0"));
      writeFileSync(files.core, pkg("@alisio/core", "1.0.0"));
      writeFileSync(files.cli, pkg("@alisio/alisio-code", "1.0.0"));
      const before = Object.fromEntries(
        Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]),
      );
      const plan = planPublish(
        { all: false, packages: ["cli", "sdk"], dryRun: true, build: true },
        root,
      );
      expect(plan.map((p) => p.name)).toEqual(["@alisio/sdk", "@alisio/alisio-code"]);
      expect(plan[0]?.tarball).toBe("alisio-sdk-1.0.0.tgz");
      expect(plan[1]?.tarball).toBe("alisio-alisio-code-1.0.0.tgz");
      // Files are byte-for-byte untouched by planning.
      for (const [k, f] of Object.entries(files)) expect(readFileSync(f, "utf8")).toBe(before[k]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the would-be version for --version without writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-publish-version-"));
    try {
      mkdirSync(join(root, "packages", "sdk"), { recursive: true });
      const file = join(root, "packages", "sdk", "package.json");
      writeFileSync(file, pkg("@alisio/sdk", "0.1.0-alpha.2"));
      const plan = planPublish(
        { all: false, packages: ["sdk"], version: "0.2.0", dryRun: true, build: true },
        root,
      );
      expect(plan[0]?.version).toBe("0.2.0");
      expect(plan[0]?.tarball).toBe("alisio-sdk-0.2.0.tgz");
      expect(readFileSync(file, "utf8")).toContain('"version": "0.1.0-alpha.2"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("publish script: version bump", () => {
  it("sets the version in every target and preserves unrelated fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-publish-bump-"));
    try {
      const a = join(root, "a.json");
      const b = join(root, "b.json");
      writeFileSync(a, pkg("@alisio/sdk", "0.1.0-alpha.2"));
      writeFileSync(
        b,
        pkg("@alisio/core", "0.1.0-alpha.3", { exports: { ".": { import: "./dist/index.js" } } }),
      );
      bumpVersions([a, b], "0.2.0");
      const parsedA = JSON.parse(readFileSync(a, "utf8")) as Record<string, unknown>;
      const parsedB = JSON.parse(readFileSync(b, "utf8")) as Record<string, unknown>;
      expect(parsedA.version).toBe("0.2.0");
      expect(parsedB.version).toBe("0.2.0");
      expect(parsedB.exports).toEqual({ ".": { import: "./dist/index.js" } });
      expect(parsedA.name).toBe("@alisio/sdk");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails cleanly and leaves files untouched when a target is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-publish-bumpfail-"));
    try {
      const a = join(root, "a.json");
      const missing = join(root, "missing.json");
      writeFileSync(a, pkg("@alisio/sdk", "0.1.0-alpha.2"));
      const before = readFileSync(a, "utf8");
      expect(() => bumpVersions([a, missing], "0.2.0")).toThrow();
      expect(readFileSync(a, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("publish script: argument parsing", () => {
  it("requires --all or --package", () => {
    expect(() => parsePublishArgs([])).toThrow(/--all|--package/);
    expect(parsePublishArgs(["--all"]).all).toBe(true);
    expect(parsePublishArgs(["--package", "cli"]).packages).toEqual(["cli"]);
  });

  it("rejects unknown packages and flags", () => {
    expect(() => parsePublishArgs(["--package", "nope"])).toThrow(/Unknown package: nope/);
    expect(() => parsePublishArgs(["--all", "--bogus"])).toThrow(/Unknown flag/);
  });

  it("defaults build on and accepts --dry-run / --no-build / --version", () => {
    expect(parsePublishArgs(["--package", "sdk"]).build).toBe(true);
    expect(parsePublishArgs(["--package", "sdk", "--no-build"]).build).toBe(false);
    expect(parsePublishArgs(["--all", "--dry-run"]).dryRun).toBe(true);
    expect(parsePublishArgs(["--all", "--version", "0.2.0"]).version).toBe("0.2.0");
    expect(() => parsePublishArgs(["--all", "--version", "not-semver"])).toThrow(/Invalid version/);
  });

  it("parses the canonical pnpm and direct node forms equivalently", () => {
    const forwarded = parsePublishArgs(["--", "--package", "cli", "--version", "0.1.0-alpha.6"]);
    const direct = parsePublishArgs(["--package", "cli", "--version", "0.1.0-alpha.6"]);
    expect(forwarded).toEqual(direct);
    expect(forwarded).toMatchObject({
      packages: ["cli"],
      version: "0.1.0-alpha.6",
      build: true,
    });
  });

  it("skips leading, repeated and trailing -- separators as no-ops", () => {
    expect(parsePublishArgs(["--", "--package", "cli"]).packages).toEqual(["cli"]);
    expect(parsePublishArgs(["--", "--all"]).all).toBe(true);
    expect(parsePublishArgs(["--", "--package", "cli", "--dry-run"]).dryRun).toBe(true);
    expect(
      parsePublishArgs(["--", "--", "--package", "cli", "--", "--version", "0.1.0-alpha.6", "--"]),
    ).toMatchObject({ packages: ["cli"], version: "0.1.0-alpha.6" });
    expect(parsePublishArgs(["--", "--package", "cli", "--no-build", "--"]).build).toBe(false);
  });

  it("still rejects unknown flags after skipped separators", () => {
    expect(() => parsePublishArgs(["--", "--bogus"])).toThrow(/Unknown flag/);
  });

  it("computes npm tarball names for scoped packages", () => {
    expect(tarballName("@alisio/sdk", "1.2.3")).toBe("alisio-sdk-1.2.3.tgz");
    expect(tarballName("@alisio/alisio-code", "0.1.0-alpha.4")).toBe(
      "alisio-alisio-code-0.1.0-alpha.4.tgz",
    );
  });
});
