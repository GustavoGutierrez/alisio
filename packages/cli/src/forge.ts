/**
 * `alisio forge status`: what `GET /api/forge` will report, for the terminal. It builds the engine
 * from the configuration alone (no application, no database): the WASM is checked against its
 * pinned hash, the host files are looked for, and `--probe` runs a real isolate end to end.
 */
type Common = { cwd?: string; config?: string; trustProject?: boolean; json?: boolean };

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;

export async function printForgeStatus(o: Common, probe: boolean): Promise<void> {
  const core = await import("@alisio/core");
  const workspace = await core.findWorkspace(o.cwd ?? process.cwd());
  const { config } = await core.loadConfigWithProvenance(workspace, {
    file: o.config,
    trustProject: o.trustProject,
  });
  const engine = core.forgeEngineFor(config.forge);
  const { pythonBackendDescriptors } = await import("./analysis.ts");
  const python = await pythonBackendDescriptors(o);
  const base = await core.describeForge(config.forge, engine);
  const status = {
    ...base,
    engines: [...base.engines, ...python],
    python: { runtime: config.analysis.runtime, isolation: config.analysis.isolation },
  };
  const probed = probe ? await engine.probe() : undefined;
  if (o.json) {
    process.stdout.write(
      `${JSON.stringify({ ...status, ...(probed ? { probe: probed } : {}) })}\n`,
    );
    return;
  }
  const js = status.javascript;
  const descriptor = status.engines[0];
  const lines = [
    `JavaScript   ${js.enabled ? "enabled" : "disabled"}   ${descriptor?.ready ? "ready" : "not ready"}`,
    `  engine     ${descriptor?.id ?? "javascript-quickjs"}  ${js.version}`,
    `  isolation  ${descriptor?.isolation ?? "none"}  (${js.host} host${js.hostSetting === "auto" ? "" : `, forced by forge.javascript.host=${js.hostSetting}`})`,
    `  wasm       sha256 ${js.wasmSha256}${js.verified ? "  verified" : ""}`,
  ];
  if (!descriptor?.ready && descriptor?.reason) lines.push(`  reason     ${descriptor.reason}`);
  if (js.verification) lines.push(`  problem    ${js.verification}`);
  lines.push(
    `  limits     timeout ${js.limits.timeoutMs} ms, heap ${mib(js.limits.memoryBytes)}, stack ${Math.round(js.limits.stackBytes / 1024)} KiB, ${js.limits.maxToolCalls} calls (${js.limits.maxConcurrency} at once), ${js.limits.maxOutputChars} output chars`,
    `  state      ${status.state.enabled ? "on" : "off"}    scratchpad ${status.scratch.enabled ? "on" : "off"}`,
  );
  lines.push(
    "",
    `Python       analysis.runtime=${config.analysis.runtime}  isolation=${config.analysis.isolation}`,
  );
  for (const backend of python)
    lines.push(
      `  ${backend.id.replace(/^python-/, "").padEnd(10)} ${backend.isolation.padEnd(13)} ${backend.ready ? "ready    " : "not ready"}  network ${backend.capabilities.networkDeniedByOS ? "denied by the OS" : "not blocked"}${backend.profiles?.length ? `  profiles ${backend.profiles.join(",")}` : ""}${backend.reason ? `  (${backend.reason})` : ""}`,
    );
  if (probed)
    lines.push(
      probed.ok
        ? `  probe      ok, a ${probed.host} isolate ran a script in ${probed.bootMs} ms`
        : `  probe      FAILED (${probed.host} host): ${probed.reason}`,
    );
  process.stdout.write(`${lines.join("\n")}\n`);
  if (probed && !probed.ok) process.exitCode = 1;
}
