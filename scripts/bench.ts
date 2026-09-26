import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const binary = resolve(process.platform === "win32" ? "dist/alisio.exe" : "dist/alisio");
const values: number[] = [];
for (let i = 0; i < 30; i++) {
  const start = performance.now();
  const child = spawnSync(binary, ["--help"], { stdio: ["ignore", "ignore", "pipe"] });
  if (child.status) throw new Error(child.stderr.toString());
  values.push(performance.now() - start);
}
values.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      scenario: "compiled --help, warm OS cache",
      samples: values.length,
      platform: process.platform,
      arch: process.arch,
      runner: `node ${process.versions.node}`,
      p50Ms: values[Math.floor(values.length * 0.5)],
      p95Ms: values[Math.floor(values.length * 0.95)],
      scope: "CLI startup only; excludes model latency, tools and repository scans",
    },
    null,
    2,
  ),
);
