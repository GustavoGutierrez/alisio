/**
 * The live log of an execution, `<sessionDir>/tasks/<executionId>.log` (spec §9.4): bounded,
 * created `0600`, best effort. The model can `tail` it while a long script runs. A failure to
 * write never affects the execution.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const TASK_LOG_MAX_BYTES = 256 * 1024;

export class TaskLog {
  readonly #path: string;
  readonly #max: number;
  #written = 0;
  #closed = false;
  #chain: Promise<void> = Promise.resolve();

  constructor(path: string, max: number = TASK_LOG_MAX_BYTES) {
    this.#path = path;
    this.#max = max;
  }

  /** Appends one line (a newline is added). Over the bound, one marker line is written and the rest dropped. */
  write(line: string): void {
    if (this.#closed) return;
    const text = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = Buffer.byteLength(text);
    let data = text;
    if (this.#written + bytes > this.#max) {
      this.#closed = true;
      data = "[log truncated: size limit reached]\n";
    }
    this.#written += Buffer.byteLength(data);
    this.#chain = this.#chain
      .then(async () => {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        await appendFile(this.#path, data, { mode: 0o600 });
      })
      .catch(() => {});
  }

  /** Resolves when everything written so far reached the file. */
  async flush(): Promise<void> {
    await this.#chain;
  }
}
