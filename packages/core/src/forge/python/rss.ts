/**
 * Resident memory of a process in MiB, for the `wasm` backend's soft memory limit (PD13). Linux
 * reads `/proc`; macOS and the BSDs ask `ps`; Windows asks `tasklist`. `undefined` when it cannot
 * be read (the limit then is not enforced for that sample).
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export type RssReader = (pid: number) => Promise<number | undefined>;

function procRss(pid: number): number | undefined {
  try {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) / 1024 : undefined;
  } catch {
    return undefined;
  }
}

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000, windowsHide: true }, (error, out) =>
      resolve(error ? undefined : String(out)),
    );
  });
}

export const readRssMb: RssReader = async (pid) => {
  if (process.platform === "linux") return procRss(pid);
  if (process.platform === "win32") {
    const out = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const kb = out ? /"([\d.,\s]+) K"\s*$/m.exec(out)?.[1]?.replace(/[^\d]/g, "") : undefined;
    return kb ? Number(kb) / 1024 : undefined;
  }
  const out = await run("ps", ["-o", "rss=", "-p", String(pid)]);
  const kb = out ? Number(out.trim()) : Number.NaN;
  return Number.isFinite(kb) ? kb / 1024 : undefined;
};
