/**
 * The Alisio host: runs inside a child process of the Electron binary (`ELECTRON_RUN_AS_NODE=1`),
 * i.e. plain Node, and starts the same HTTP + SSE server as `alisio serve`. It reports the launch
 * URL to its parent over IPC (or as one JSON stdout line when started without a channel).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { installOutputRedaction } from "./redact-output.ts";
import { parseHostArgs } from "./spawn-plan.ts";

type HostReport = { type: "ready"; launchUrl: string } | { type: "error"; message: string };

function report(message: HostReport): void {
  if (process.send) process.send(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}

function desktopVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}

/** Same shape as the core JWT rule; covers output written before `@alisio/core` has loaded. */
const EARLY_JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;

async function main(): Promise<void> {
  // Nothing the host prints (server logs, plugins, libraries) may carry a token (specs/025 D26a).
  // The wrapper goes in before the slow imports so that nothing printed while they load escapes it;
  // no exact secret can be registered yet, so the JWT rule is all the early window needs.
  let redact = (text: string): string => text.replace(EARLY_JWT, "[redacted]");
  installOutputRedaction((text) => redact(text), [process.stdout, process.stderr]);
  const [{ startServer }, { cliDefaults }, { redactCredentials }] = await Promise.all([
    import("@alisio/server"),
    import("@alisio/alisio-code/defaults"),
    import("@alisio/core"),
  ]);
  redact = (text) => redactCredentials(text);
  const { webRoot } = parseHostArgs(process.argv.slice(2));
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    // The window and this process share one machine by construction: sign-in methods may use a
    // loopback listener without the "only if your browser is on this computer" caveat (D16).
    localBrowser: true,
    version: desktopVersion(),
    defaultWorkspace: homedir(),
    app: await cliDefaults(),
    ...(webRoot ? { webRoot } : {}),
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Shutdown is bounded internally; this is a last-resort guard against a hung close.
    setTimeout(() => process.exit(1), 8_000).unref();
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // The parent is gone (crash or quit): nobody can reach this server any more.
  process.on("disconnect", stop);
  report({ type: "ready", launchUrl: server.launchUrl });
}

main().catch((error: unknown) => {
  report({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  // Give the IPC message time to flush, then leave even if handles keep the loop alive.
  setTimeout(() => process.exit(1), 200).unref();
});
