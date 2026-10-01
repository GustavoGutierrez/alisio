// A portable stand-in for the Docker/Podman CLI in tests. Usage as the engine command:
//   node fake-container.mjs <stateDir> <engine args…>
// It understands `version`, `info`, `run`, `kill`, `ps`, `pull` and `image inspect`, records every
// invocation in <stateDir>/calls.jsonl and keeps one marker per live container in
// <stateDir>/containers/. `run` starts the "container" as a detached process (like a daemon-owned
// container) that executes the script with fake-python.mjs, so killing only the CLIENT leaves the
// container alive until `kill <name>` is called: exactly what the real engines can do.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PYTHON = join(here, "fake-python.mjs");
const [, , state, ...args] = process.argv;
mkdirSync(join(state, "containers"), { recursive: true });
const marker = (name) => join(state, "containers", `${name}.json`);

if (args[0] === "--container") {
  // The "container" itself: argv = --container <name> <planFile>
  const [, name, planFile] = args;
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const child = spawn(process.execPath, [FAKE_PYTHON, plan.main], {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("close", (code) => {
    rmSync(marker(name), { force: true });
    process.exit(code ?? 1);
  });
} else {
  appendFileSync(join(state, "calls.jsonl"), `${JSON.stringify(args)}\n`);
  const [verb] = args;
  if (verb === "version") process.stdout.write("27.0.0-fake\n");
  else if (verb === "info") process.stdout.write(process.env.FAKE_ROOTLESS ? "true\n" : "false\n");
  else if (verb === "pull") process.stdout.write(`pulled ${args[1]}\n`);
  else if (verb === "image") process.stdout.write(`["${process.env.FAKE_DIGEST ?? ""}"]\n`);
  else if (verb === "ps") {
    for (const file of readdirSync(join(state, "containers")).filter((f) => f.endsWith(".json")))
      process.stdout.write(`${file.replace(/\.json$/, "")}\n`);
  } else if (verb === "kill") {
    const file = marker(args[1]);
    if (!existsSync(file)) {
      process.stderr.write(`Error: No such container: ${args[1]}\n`);
      process.exit(1);
    }
    // The whole process group: the "container" and the script it runs (a real container stops all of it).
    const { pid } = JSON.parse(readFileSync(file, "utf8"));
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-pid, "SIGKILL");
    } catch {}
    rmSync(file, { force: true });
    process.stdout.write(`${args[1]}\n`);
  } else if (verb === "run") {
    const mounts = [];
    const env = {};
    let name = "";
    let workdir = "/";
    let i = 1;
    for (; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--name") name = args[++i];
      else if (arg === "-v") {
        const [src, dst] = args[++i].split(/:(\/job[^:]*)/).filter(Boolean);
        mounts.push([src, dst]);
      } else if (arg === "-e") {
        const [key, ...rest] = args[++i].split("=");
        env[key] = rest.join("=");
      } else if (arg === "-w") workdir = args[++i];
      else if (["--label", "--tmpfs", "--user"].includes(arg)) i++;
      else if (arg.startsWith("-")) continue;
      else break;
    }
    const image = args[i];
    const command = args.slice(i + 1);
    const host = (path) => {
      for (const [src, dst] of mounts)
        if (path === dst || path.startsWith(`${dst}/`))
          return resolve(src, path.slice(dst.length + 1));
      return path;
    };
    const hostEnv = { ...process.env };
    for (const [key, value] of Object.entries(env))
      hostEnv[key] = value.startsWith("/job") ? host(value) : value;
    const plan = { main: host(command.at(-1)), cwd: host(workdir), env: hostEnv };
    const planFile = join(state, "containers", `${name}.plan`);
    writeFileSync(planFile, JSON.stringify(plan));
    const daemon = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), state, "--container", name, planFile],
      {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    writeFileSync(marker(name), JSON.stringify({ pid: daemon.pid, image }));
    daemon.on("close", (code) => {
      rmSync(planFile, { force: true });
      process.exit(code ?? 1);
    });
    // The client dies on SIGTERM without stopping the container (a real engine may do this too).
    process.on("SIGTERM", () => process.exit(143));
  } else process.exit(2);
}
