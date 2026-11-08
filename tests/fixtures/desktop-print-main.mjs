// Electron main for the gated print test: prints one bundle through the real print service.
import { app } from "electron";
import { createPrinter } from "../../apps/desktop/src/print.ts";

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const job = JSON.parse(process.env.PRINT_JOB);
  const result = await createPrinter().print({ type: "print", ...job });
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  app.exit(0);
});
