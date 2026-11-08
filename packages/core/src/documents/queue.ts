/** Render queue (spec 026 D19): at most N concurrent renders, `DOCUMENT_BUSY` past the queue limit. */
import { DOCUMENT_LIMITS, DocumentError } from "./limits.ts";

export class RenderQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly maxQueued: number;
  constructor(
    concurrency: number = DOCUMENT_LIMITS.concurrentRenders,
    maxQueued: number = DOCUMENT_LIMITS.queuedRenders,
  ) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
  }

  async run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.maxQueued)
        throw new DocumentError(
          "DOCUMENT_BUSY",
          "Too many documents are being rendered. Try again in a moment.",
        );
      await new Promise<void>((resolve, reject) => {
        const entry = () => resolve();
        this.waiting.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            const i = this.waiting.indexOf(entry);
            if (i >= 0) {
              this.waiting.splice(i, 1);
              reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
            }
          },
          { once: true },
        );
      });
    } else this.running++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
