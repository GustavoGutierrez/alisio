// A stand-in for the restricted `node` that runs Pyodide (wasm Python backend), for tests that need
// no real Pyodide. A wrapper script runs `node fake-node.mjs <behaviour flags> <the real args>`.
//
//   --version                   prints v22.22.0 (or the value of --reports=<v>)
//   -e / --input-type           the network probe: prints DENIED ... (--net=denied) or connects
//   otherwise                   runner mode: the last argument is the runner's JSON spec; the
//                               script `<spec.job.script>/main.py` carries a `# fake: {...}` line
// Plan keys (all optional): files, frames, stdout, stderr, exit, sleepMs, hang, allocMb,
//   startupMs (delay before the ready file), echo (prints ARGS/ENV/CWD/SPEC as JSON lines).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

const own = process.argv.slice(2);
const flag = (name) => own.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const real = own.filter((a) => !/^--(net|reports)=/.test(a));
const reports = flag("reports") ?? "v22.22.0";

if (real.includes("--version")) {
  console.log(reports);
  process.exit(0);
}
if (real.includes("-e")) {
  // The probe: argv ends with the port. Either behave as Node 22 (connect) or as Node 25 (denied).
  const port = Number(real.at(-1));
  if (flag("net") === "denied") {
    console.log("DENIED ERR_ACCESS_DENIED");
    process.exit(0);
  }
  // Any other error code is a failed connection, not the Permission Model.
  if (flag("net")?.startsWith("error:")) {
    console.log(`DENIED ${flag("net").slice("error:".length)}`);
    process.exit(0);
  }
  const socket = connect(port, "127.0.0.1");
  socket.on("connect", () => {
    console.log("CONNECTED");
    process.exit(0);
  });
  socket.on("error", () => {
    console.log("DENIED ECONNREFUSED");
    process.exit(0);
  });
} else {
  const spec = JSON.parse(real.at(-1));
  const main = join(spec.job.script, "main.py");
  const line = readFileSync(main, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("# fake:"));
  const plan = line ? JSON.parse(line.slice("# fake:".length)) : {};
  const run = () => {
    if (plan.echo) {
      process.stdout.write(`ARGS:${JSON.stringify(real.slice(0, -1))}\n`);
      process.stdout.write(`ENV:${JSON.stringify(process.env)}\n`);
      process.stdout.write(`CWD:${process.cwd()}\n`);
      process.stdout.write(`SPEC:${JSON.stringify(spec)}\n`);
    }
    if (plan.listScratch && spec.job.scratch) {
      const names = readdirSync(spec.job.scratch, { recursive: true }).sort();
      process.stdout.write(`SCRATCH:${JSON.stringify(names)}\n`);
    }
    for (const [rel, content] of Object.entries(plan.files ?? {})) {
      const target = join(spec.job.out, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    let seq = 0;
    for (const item of plan.frames ?? []) {
      const nonce = process.env.ALISIO_FORGE_NONCE ?? "no-nonce";
      const message = {
        protocol: 1,
        type: item.type,
        seq: item.seq ?? seq++,
        payload: item.payload,
      };
      process.stdout.write(`\u001eALISIO-FORGE:${nonce}:${JSON.stringify(message)}\n`);
    }
    if (plan.stdout) process.stdout.write(plan.stdout);
    if (plan.stderr) process.stderr.write(plan.stderr);
    let held;
    if (plan.allocMb) {
      held = Buffer.alloc(plan.allocMb * 1024 * 1024, 1);
      process.stdout.write(`ALLOCATED:${held.length}\n`);
    }
    if (plan.hang || plan.allocMb) {
      setInterval(() => held?.at(0), 1000);
      return;
    }
    const finish = () =>
      process.stdout.write("", () => process.stderr.write("", () => process.exit(plan.exit ?? 0)));
    if (plan.sleepMs) setTimeout(finish, plan.sleepMs);
    else finish();
  };
  const ready = () => {
    // Like the real runner: a file under work/.forge tells the parent the start is over.
    mkdirSync(join(spec.job.work, ".forge"), { recursive: true });
    writeFileSync(join(spec.job.work, ".forge", "wasm-ready"), String(plan.startupMs ?? 5));
    run();
  };
  if (plan.startupMs) setTimeout(ready, plan.startupMs);
  else ready();
}
