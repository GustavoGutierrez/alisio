/**
 * Task logs: one append-only file per task under `<state>/tasks/<root session>/<task id>.log`,
 * written with synchronous appends (chunks are small) so a reader never sees less than what the
 * writer reported. Readers address the file by byte offset: nothing is ever rewritten, so an offset
 * stays valid for the life of the task.
 *
 * Size limit: the first `maxBytes` of output are kept, then ONE marker line. The rest is not
 * stored, except for a rolling tail of the last `TAIL_BYTES` which is appended when the task ends,
 * so the error at the end of a very long build is still readable.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inside } from "../runtime/paths.ts";

export const TAIL_BYTES = 32 * 1024;
/** Default size of one `bg_output` read and its hard maximum. */
export const DEFAULT_READ_BYTES = 16 * 1024;
export const MAX_READ_BYTES = 64 * 1024;

/** The folder and relative path of a task log under the state root. */
export const taskLogPath = (rootSession: string, id: string): string =>
  join("tasks", rootSession, `${id}.log`);

/** Absolute path of a stored (relative) log path; refuses anything that escapes the state root. */
export function resolveLogPath(stateRoot: string, relativePath: string): string {
  const absolute = resolve(stateRoot, relativePath);
  if (isAbsolute(relativePath) || !inside(resolve(stateRoot), absolute))
    throw new Error("Invalid task log path");
  return absolute;
}

/** Length of the longest prefix of `bytes` that does not end in the middle of a UTF-8 sequence. */
export function completeUtf8Length(bytes: Uint8Array): number {
  let end = bytes.length;
  // Walk back over at most 3 continuation bytes to the lead byte of the last character.
  for (let back = 1; back <= 4 && end - back >= 0; back++) {
    const byte = bytes[end - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return back < needed ? end - back : end;
  }
  return end;
}

/** The writing side of one task log. */
export class TaskLogWriter {
  private fd: number | undefined;
  private written = 0;
  private cut = false;
  private received = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly maxBytes: number,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.fd = openSync(path, "a", 0o600);
  }

  /** Bytes in the file so far. */
  get bytes(): number {
    return this.written;
  }

  /** Whether output was left out of the stored log. */
  get truncated(): boolean {
    return this.cut;
  }

  append(chunk: string | Buffer): void {
    if (this.closed || this.fd === undefined) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (!buffer.length) return;
    this.received += buffer.length;
    if (this.cut) return this.keepTail(buffer);
    const room = this.maxBytes - this.written;
    if (buffer.length <= room) return this.write(buffer);
    const head = buffer.subarray(0, Math.max(0, room));
    // Never end the stored head in the middle of a character.
    const whole = head.subarray(0, completeUtf8Length(head));
    if (whole.length) this.write(whole);
    this.write(
      Buffer.from(
        `\n[output truncated: the log limit of ${this.maxBytes} bytes was reached; the last ${TAIL_BYTES} bytes are appended when the task ends]\n`,
      ),
    );
    this.cut = true;
    this.keepTail(buffer.subarray(whole.length));
  }

  private keepTail(buffer: Buffer): void {
    this.tail.push(buffer);
    this.tailBytes += buffer.length;
    while (this.tailBytes - (this.tail[0]?.length ?? 0) >= TAIL_BYTES) {
      this.tailBytes -= (this.tail.shift() as Buffer).length;
    }
  }

  private write(buffer: Buffer): void {
    if (this.fd === undefined) return;
    try {
      writeSync(this.fd, buffer);
      this.written += buffer.length;
    } catch {
      /* A full disk never fails the task itself. */
    }
  }

  /** Appends the tail of a truncated log and closes the file. Idempotent. */
  finish(): void {
    if (this.closed) return;
    if (this.cut && this.tailBytes > 0) {
      let tail = Buffer.concat(this.tail);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
      // The cut may split a character at the start of the tail.
      let start = 0;
      while (start < tail.length && start < 4 && ((tail[start] as number) & 0xc0) === 0x80) start++;
      tail = tail.subarray(start);
      const omitted = this.received - this.written - tail.length;
      if (omitted > 0)
        this.write(
          Buffer.from(`\n[... ${omitted} bytes omitted; the end of the output follows ...]\n`),
        );
      this.write(tail);
    }
    this.closed = true;
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = undefined;
    }
  }
}

export interface LogRead {
  text: string;
  nextOffset: number;
  /** Size of the file at the time of the read. */
  size: number;
}

/**
 * Reads at most `limit` bytes of a log from `offset`. The text ends at a character boundary:
 * `nextOffset` is where the next read must start. A missing file reads as empty.
 */
export async function readLog(path: string, offset: number, limit: number): Promise<LogRead> {
  const start = Math.max(0, Math.floor(offset));
  const want = Math.max(1, Math.min(Math.floor(limit), MAX_READ_BYTES));
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return { text: "", nextOffset: start, size: 0 };
  }
  if (start >= size) return { text: "", nextOffset: start, size };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(want, size - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let slice = buffer.subarray(0, bytesRead);
    // Hold back an incomplete trailing character (the next read completes it); if that leaves
    // nothing (a lone broken byte), return the raw bytes so a reader always makes progress.
    slice = slice.subarray(0, completeUtf8Length(slice));
    if (!slice.length && bytesRead) slice = buffer.subarray(0, bytesRead);
    return { text: new TextDecoder().decode(slice), nextOffset: start + slice.length, size };
  } finally {
    await handle.close();
  }
}

/** Appends a note to a finished log file (used for spawn errors); best effort. */
export function appendNote(path: string, note: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, note, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

export async function removeLog(path: string): Promise<void> {
  await rm(path, { force: true });
}
