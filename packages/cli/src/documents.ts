/** `alisio documents status`: engine readiness without starting an application (DOC-AC-31). */
type Common = { cwd?: string; config?: string; trustProject?: boolean; json?: boolean };

export async function printDocumentsStatus(o: Common): Promise<void> {
  const core = await import("@alisio/core");
  const workspace = await core.findWorkspace(o.cwd ?? process.cwd());
  const { config } = await core.loadConfigWithProvenance(workspace, {
    file: o.config,
    trustProject: o.trustProject,
  });
  const engines = await core.documentEngineStatus({ explicitPath: config.documents.chromiumPath });
  if (o.json) {
    process.stdout.write(
      `${JSON.stringify({ enabled: config.documents.enabled, engine: config.documents.engine, engines })}\n`,
    );
    return;
  }
  const lines = [
    `Documents    ${config.documents.enabled ? "enabled" : "disabled"}   engine=${config.documents.engine}   page=${config.documents.defaultPageSize}`,
  ];
  for (const e of engines) {
    lines.push(`  ${e.id.padEnd(10)} ${e.ready ? `ready      ${e.version ?? ""}` : "not ready"}`);
    if (!e.ready && e.reason) lines.push(`    reason   ${e.reason}`);
    if (!e.ready && e.fix) lines.push(`    fix      ${e.fix}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
