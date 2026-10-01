// A portable stand-in for a Python interpreter in tests (run with `node fake-python.mjs <flags>
// main.py`). The "script" is a `# fake: {...}` JSON line telling it what to do, so tests never
// need a real Python: write files to $ALISIO_OUTPUT_DIR, print, sleep, exit with a code.
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
if (plan.stdout) process.stdout.write(plan.stdout);
if (plan.stderr) process.stderr.write(plan.stderr);
const finish = () => process.exit(plan.exit ?? 0);
if (plan.sleepMs) setTimeout(finish, plan.sleepMs);
else finish();
