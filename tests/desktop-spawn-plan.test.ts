import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHostSpawn,
  parseHostArgs,
  resolveRuntimePaths,
} from "../apps/desktop/src/spawn-plan.ts";

describe("desktop spawn plan", () => {
  it("runs the entry through the given executable with Node semantics and an inherited env", () => {
    const plan = buildHostSpawn({
      execPath: "/opt/Alisio/alisio",
      hostEntry: "/opt/Alisio/resources/runtime/dist/host.js",
      parentEnv: { PATH: "/bin", HOME: "/home/u" },
    });
    expect(plan.command).toBe("/opt/Alisio/alisio");
    expect(plan.args).toEqual(["/opt/Alisio/resources/runtime/dist/host.js"]);
    expect(plan.env).toEqual({ PATH: "/bin", HOME: "/home/u", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("forces ELECTRON_RUN_AS_NODE even when the parent set another value, and does not mutate it", () => {
    const parentEnv = { ELECTRON_RUN_AS_NODE: "0" };
    const plan = buildHostSpawn({ execPath: "e", hostEntry: "h.js", parentEnv });
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(parentEnv.ELECTRON_RUN_AS_NODE).toBe("0");
  });

  it("passes the web root and extra node args", () => {
    const plan = buildHostSpawn({
      execPath: "node",
      hostEntry: "host.ts",
      parentEnv: {},
      webRoot: "/srv/web",
      nodeArgs: ["--conditions=alisio-source"],
    });
    expect(plan.args).toEqual(["--conditions=alisio-source", "host.ts", "--web-root", "/srv/web"]);
  });

  it("parses the host argv", () => {
    expect(parseHostArgs(["--web-root", "/w"])).toEqual({ webRoot: "/w" });
    expect(parseHostArgs([])).toEqual({});
    expect(parseHostArgs(["--web-root"])).toEqual({});
    expect(parseHostArgs(["--unknown", "x"])).toEqual({});
  });

  it("resolves the runtime next to the app in development", () => {
    const paths = resolveRuntimePaths({ packaged: false, appDir: "/repo/apps/desktop" });
    expect(paths.runtimeDir).toBe("/repo/apps/desktop");
    expect(paths.hostEntry).toBe(join("/repo/apps/desktop", "dist", "host.js"));
  });

  it("resolves the runtime under resources/runtime when packaged", () => {
    const paths = resolveRuntimePaths({
      packaged: true,
      appDir: "/opt/Alisio/resources/app.asar",
      resourcesPath: "/opt/Alisio/resources",
    });
    expect(paths.runtimeDir).toBe(join("/opt/Alisio/resources", "runtime"));
    expect(paths.hostEntry).toBe(join("/opt/Alisio/resources", "runtime", "dist", "host.js"));
  });

  it("refuses a packaged layout without resourcesPath", () => {
    expect(() => resolveRuntimePaths({ packaged: true, appDir: "/x" })).toThrow(/resourcesPath/);
  });
});
