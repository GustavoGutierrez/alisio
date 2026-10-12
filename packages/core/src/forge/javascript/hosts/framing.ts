/**
 * Length-prefixed JSON framing of the process host (spec §6.3, D10): a big-endian u32 byte count
 * followed by that many bytes of UTF-8 JSON. Pure. A frame over the limit or a body that is not
 * JSON breaks the stream: the caller treats it as a protocol violation and kills the child.
 *
 * Erasable TypeScript only (D-33): the isolate process loads this file under type stripping.
 */

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameStreamError";
  }
}

export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes: number) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  /** Adds bytes and returns every message completed by them. Throws `FrameStreamError`. */
  push(chunk: Uint8Array): unknown[] {
    this.#buffer =
      this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readUInt32BE(0);
      // The size is checked before the body is buffered: a hostile length never allocates.
      if (size > this.#maxFrameBytes)
        throw new FrameStreamError(
          `frame of ${size} bytes exceeds the ${this.#maxFrameBytes} limit`,
        );
      if (this.#buffer.length < 4 + size) break;
      const body = this.#buffer.subarray(4, 4 + size).toString("utf8");
      this.#buffer = this.#buffer.subarray(4 + size);
      try {
        messages.push(JSON.parse(body) as unknown);
      } catch {
        throw new FrameStreamError("frame is not valid JSON");
      }
    }
    return messages;
  }
}
