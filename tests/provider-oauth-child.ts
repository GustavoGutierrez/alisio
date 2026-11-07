/**
 * Helper process for the cross-process OAuth tests (never a test file itself). Run with
 * `node --experimental-transform-types <this file> '<json>'`; prints one JSON line.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { withFileLock } from "../packages/core/src/providers/oauth/lock.ts";
import { OAuthManager } from "../packages/core/src/providers/oauth/manager.ts";
import { ProviderSettingsStore } from "../packages/core/src/providers/settings.ts";

const job = JSON.parse(process.argv[2] ?? "{}") as Record<string, any>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(at: number) {
  while (Date.now() < at) await sleep(1);
}

async function main() {
  await waitUntil(job.startAt);
  if (job.mode === "writes") {
    const store = new ProviderSettingsStore(job.root);
    for (let i = 0; i < job.n; i++) {
      if (job.kind === "cred")
        await store.setCredentials(`pa${i}`, { apiKey: `key-${i}-abcdefgh` });
      else
        await store.setOAuth(
          `pb${i}`,
          { type: "oauth", access: `access-${i}-abcdefgh` },
          { method: "browser", provider: "chatgpt" },
        );
    }
    return { done: true };
  }
  if (job.mode === "lock") {
    // Every round races on its own (stale) lock; the marker file proves mutual exclusion.
    let violations = 0;
    let held = 0;
    for (let k = 0; k < job.rounds; k++) {
      await withFileLock(`${job.dir}/lock-${k}`, { waitMs: 5000, staleMs: 30_000 }, async () => {
        try {
          (await open(`${job.dir}/marker-${k}`, "wx")).close();
        } catch {
          violations++;
        }
        held++;
        await sleep(15);
        await unlink(`${job.dir}/marker-${k}`).catch(() => {});
      });
    }
    return { violations, held };
  }
  if (job.mode === "refresh") {
    const store = new ProviderSettingsStore(job.root);
    const registry = {
      get: () => ({
        auth: [
          {
            id: "browser",
            label: "Browser",
            kind: "oauth" as const,
            start: async () => {
              throw new Error("not used");
            },
            refresh: async () => {
              appendFileSync(`${job.root}/calls.log`, "refresh\n");
              await sleep(150);
              const n = readFileSync(`${job.root}/calls.log`, "utf8").trim().split("\n").length;
              return {
                type: "oauth" as const,
                access: `rotated-access-${n}-abcdef`,
                refresh: `rotated-refresh-${n}-abcdef`,
                expires: Date.now() + 3_600_000,
              };
            },
          },
        ],
      }),
    };
    const manager = new OAuthManager({ store, registry });
    const credential = await manager.get("p", "chatgpt");
    return { access: credential.access };
  }
  throw new Error(`unknown mode ${job.mode}`);
}

main().then(
  (result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  },
  (error) => {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exit(1);
  },
);
