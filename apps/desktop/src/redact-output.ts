/** The part of a writable stream the redaction wraps (`process.stdout` and `process.stderr`). */
export interface RedactableStream {
  write: (chunk: any, ...rest: any[]) => boolean;
}

/**
 * Wraps `write` of each stream so that text passing through is redacted first: whatever a plugin,
 * a library or the server itself prints, a known token value or a JWT never reaches the Electron
 * main process's log (specs/025 D26a). Buffers are decoded as UTF-8 only to look for a match;
 * bytes that are not valid text, or text with nothing to redact, go through untouched. Returns the
 * function that restores the original writers.
 */
export function installOutputRedaction(
  redact: (text: string) => string,
  streams: RedactableStream[],
): () => void {
  const originals = streams.map((stream) => stream.write);
  streams.forEach((stream, index) => {
    const original = originals[index] as RedactableStream["write"];
    stream.write = (chunk, ...rest) => {
      let next = chunk;
      if (typeof chunk === "string") next = redact(chunk);
      else if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
        // A replacement character means the bytes were not text: leave them alone.
        if (!text.includes("�")) {
          const clean = redact(text);
          if (clean !== text) next = clean;
        }
      }
      return original.call(stream, next, ...rest);
    };
  });
  return () => {
    streams.forEach((stream, index) => {
      stream.write = originals[index] as RedactableStream["write"];
    });
  };
}
