import { resolve } from "node:path";

const binary = resolve(process.platform === "win32" ? "dist/alisio.exe" : "dist/alisio");
const values: number[] = [];
for (let i = 0; i < 30; i++) {
  const start = performance.now();
  const child = Bun.spawn([binary, "--help"], { stdout: "ignore", stderr: "pipe" });
  const code = await child.exited;
  if (code) throw new Error(await new Response(child.stderr).text());
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
      bun: Bun.version,
      p50Ms: values[Math.floor(values.length * 0.5)],
      p95Ms: values[Math.floor(values.length * 0.95)],
      scope: "CLI startup only; excludes model latency, tools and repository scans",
    },
    null,
    2,
  ),
);
