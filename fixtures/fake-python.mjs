// A portable stand-in for a Python interpreter in tests (run with `node fake-python.mjs <flags>
// main.py`). The "script" is a `# fake: {...}` JSON line telling it what to do, so tests never
// need a real Python: write files to $ALISIO_OUTPUT_DIR, print, sleep, exit with a code.
//
// Forja additions (all optional, all additive):
//   frames: [{ type, payload, seq? }]  protocol frames on stdout with $ALISIO_FORGE_NONCE
//   rawLines: ["..."]                  lines printed verbatim (fake frames, odd output)
//   manyFrames: n                      n `progress` frames
//   giantFrame: bytes                  one `progress` frame whose message has that many bytes
//   state: true                        prints `STATE:<work/.forge/state.json>` (the snapshot)
//   scratch: { read?: "file", write?: "file" }  reads/writes through $ALISIO_SCRATCH_DIR and
//                                      prints `SCRATCH:<json>` with the env value and the outcome
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const main = process.argv.at(-1);
const line = readFileSync(main, "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("# fake:"));
const plan = line ? JSON.parse(line.slice("# fake:".length)) : {};
const out = process.env.ALISIO_OUTPUT_DIR;
for (const [rel, content] of Object.entries(plan.files ?? {})) {
  const target = join(out, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
if (plan.env)
  process.stdout.write(
    `${JSON.stringify({ home: process.env.HOME, cwd: process.cwd(), key: process.env.OPENAI_API_KEY ?? null, mpl: process.env.MPLBACKEND })}\n`,
  );
let seq = 0;
const frame = (type, payload, at) => {
  const nonce = process.env.ALISIO_FORGE_NONCE ?? "no-nonce";
  const message = { protocol: 1, type, seq: at ?? seq++, payload };
  process.stdout.write(`\u001eALISIO-FORGE:${nonce}:${JSON.stringify(message)}\n`);
};
for (const item of plan.frames ?? []) frame(item.type, item.payload, item.seq);
for (let i = 0; i < (plan.manyFrames ?? 0); i++) frame("progress", { message: `step ${i}` });
if (plan.giantFrame) frame("progress", { message: "x".repeat(plan.giantFrame) });
for (const raw of plan.rawLines ?? []) process.stdout.write(`${raw}\n`);
if (plan.state)
  process.stdout.write(
    `STATE:${readFileSync(join(process.env.ALISIO_WORK_DIR, ".forge", "state.json"), "utf8")}\n`,
  );
if (plan.scratch) {
  const dir = process.env.ALISIO_SCRATCH_DIR ?? null;
  const report = { dir };
  if (dir && plan.scratch.read) report.read = readFileSync(join(dir, plan.scratch.read), "utf8");
  if (dir && plan.scratch.write) {
    try {
      writeFileSync(join(dir, plan.scratch.write), "from python");
      report.write = "ok";
    } catch (error) {
      report.write = error.code ?? "error";
    }
  }
  process.stdout.write(`SCRATCH:${JSON.stringify(report)}\n`);
}
if (plan.stdout) process.stdout.write(plan.stdout);
if (plan.stderr) process.stderr.write(plan.stderr);
// Exit only once stdout and stderr were flushed: a pipe write can be asynchronous, and a large burst
// of frames must not be cut off by the exit.
const finish = () =>
  process.stdout.write("", () => process.stderr.write("", () => process.exit(plan.exit ?? 0)));
if (plan.sleepMs) setTimeout(finish, plan.sleepMs);
else finish();
