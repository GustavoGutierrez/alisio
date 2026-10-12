/**
 * `StdoutFrameTransport` (Python spec §7, PD9): turns the frames of a script's stdout into common
 * protocol messages for the kernel. The guest is untrusted: every frame is validated like any
 * guest message (schema, sequence, size, depth, forbidden keys) with tool calls switched off, and a
 * frame the host cannot accept ends the execution with `PROTOCOL_VIOLATION`.
 *
 * Messages reach the kernel one at a time, in the order they were written. Past `MAX_FRAMES`
 * messages the rest is ignored with one warning, and the run goes on. Ordinary output is passed
 * to `onText` exactly as it came.
 */
import { ForgeError, isForgeError } from "../errors.ts";
import { type GuestMessage, GuestMessageValidator } from "../protocol.ts";
import { FrameDecoder, type FrameEvent } from "./frame-parser.ts";

export const MAX_FRAMES = 1000;

export interface FrameTransportOptions {
  nonce: string;
  /** The kernel's side. Rejecting with a `ForgeError` ends the execution with that code. */
  receive: (message: GuestMessage) => Promise<unknown>;
  /** Output that is not a frame, in order. */
  onText: (text: string) => void;
  /** Called once, when the execution must end because of what the guest sent. */
  onFailure: (error: ForgeError) => void;
  maxMessages?: number;
}

export class StdoutFrameTransport {
  readonly #options: FrameTransportOptions;
  readonly #decoder: FrameDecoder;
  readonly #validator = new GuestMessageValidator({ toolCalls: false });
  readonly #max: number;
  #queue: Promise<void> = Promise.resolve();
  #seen = 0;
  #failed = false;
  #completion: { value?: unknown } | undefined;
  #fatal: { code: string; message: string } | undefined;
  readonly warnings: string[] = [];

  constructor(options: FrameTransportOptions) {
    this.#options = options;
    this.#decoder = new FrameDecoder(options.nonce);
    this.#max = options.maxMessages ?? MAX_FRAMES;
  }

  /** The value of the guest's `complete` message, when it sent one. */
  get completion(): { value?: unknown } | undefined {
    return this.#completion;
  }

  /** The guest's own `fatal` message, when it sent one. */
  get fatal(): { code: string; message: string } | undefined {
    return this.#fatal;
  }

  feed(chunk: string): void {
    this.#handle(this.#decoder.feed(chunk));
  }

  /** Flushes what is held and resolves once every accepted message was handed to the kernel. */
  async end(): Promise<void> {
    this.#handle(this.#decoder.flush());
    await this.#queue;
  }

  #handle(events: FrameEvent[]): void {
    for (const event of events) {
      if (event.type === "text") this.#options.onText(event.text);
      else this.#frame(event);
    }
  }

  #fail(error: ForgeError): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#options.onFailure(error);
  }

  #frame(event: Exclude<FrameEvent, { type: "text" }>): void {
    if (this.#failed) return;
    if (++this.#seen > this.#max) {
      if (this.warnings.length === 0)
        this.warnings.push(
          `the script sent more than ${this.#max} protocol messages; the rest was ignored`,
        );
      return;
    }
    if (event.type === "oversize")
      return this.#fail(
        new ForgeError("PROTOCOL_VIOLATION", "protocol message larger than allowed"),
      );
    let raw: unknown;
    try {
      raw = JSON.parse(event.json);
    } catch {
      return this.#fail(new ForgeError("PROTOCOL_VIOLATION", "protocol frame is not valid JSON"));
    }
    const checked = this.#validator.accept(raw);
    if (!checked.ok) return this.#fail(checked.error);
    const message = checked.message;
    if (message.type === "complete") this.#completion = { ...message.payload };
    else if (message.type === "fatal") this.#fatal = message.payload;
    if (message.type === "complete" || message.type === "fatal" || message.type === "ready") return;
    this.#queue = this.#queue.then(async () => {
      if (this.#failed) return;
      try {
        await this.#options.receive(message);
      } catch (error) {
        this.#fail(
          isForgeError(error)
            ? error
            : new ForgeError(
                "ISOLATE_FAILURE",
                error instanceof Error ? error.message : String(error),
              ),
        );
      }
    });
  }
}
