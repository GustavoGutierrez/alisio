/** Helpers for the dataset tests: a temp state folder, a session database and a service. */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatasetLimits } from "../packages/core/src/analysis/data/datasets.ts";
import { DatasetService } from "../packages/core/src/analysis/data/datasets.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

/**
 * A Python 3.10+ on `PATH` (`python3`, `python` or the Windows launcher), or undefined: tests that
 * need a real interpreter skip with `describe.skipIf(!pythonCommand)`.
 */
export const pythonCommand: string | undefined = (() => {
  for (const [command, args] of [
    ["python3", []],
    ["python", []],
    ["py", ["-3"]],
  ] as const) {
    const run = spawnSync(
      command,
      [...args, "-c", "import sys;print(sys.version_info[:2]>=(3,10))"],
      {
        encoding: "utf8",
      },
    );
    if (run.status === 0 && run.stdout.trim() === "True") return command;
  }
  return undefined;
})();

/** `DatasetService`'s Python provider for the interpreter above. */
export const realPython = {
  interpreter: async () => ({
    ok: true as const,
    executable: pythonCommand ?? "python3",
    version: "3.10.0",
    source: "python3" as const,
    ...(pythonCommand === "py" ? { prefixArgs: ["-3"] } : {}),
  }),
};

export interface DataFixture {
  root: string;
  store: SQLiteStore;
  service: DatasetService;
  /** Writes a file under the temp folder and returns its path. */
  write(name: string, content: string | Uint8Array): Promise<string>;
  ingest(
    name: string,
    content: string | Uint8Array,
    options?: { root?: string },
  ): ReturnType<DatasetService["ingest"]>;
  dispose(): Promise<void>;
}

export async function dataFixture(
  options: {
    limits?: Partial<DatasetLimits>;
    python?: ConstructorParameters<typeof DatasetService>[0]["python"];
  } = {},
): Promise<DataFixture> {
  const root = await mkdtemp(join(tmpdir(), "alisio-data-"));
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const service = new DatasetService({
    root,
    db: store.db,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.python ? { python: options.python } : {}),
  });
  const write = async (name: string, content: string | Uint8Array) => {
    const path = join(root, "files", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return path;
  };
  return {
    root,
    store,
    service,
    write,
    async ingest(name, content, opts) {
      const path = await write(name, content);
      return service.ingest({
        rootSessionId: opts?.root ?? "root-1",
        sessionId: opts?.root ?? "root-1",
        workspace: join(root, "ws"),
        path,
      });
    },
    async dispose() {
      service.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** `n` rows of `id,region,revenue`. */
export function bigCsv(n: number): string {
  const regions = ["West", "East", "North", "South"];
  const lines = ["id,region,revenue"];
  for (let i = 1; i <= n; i++) lines.push(`${i},${regions[i % 4]},${(i * 7) % 1000}.5`);
  return `${lines.join("\n")}\n`;
}
