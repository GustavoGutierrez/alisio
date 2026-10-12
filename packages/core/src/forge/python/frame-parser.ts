/**
 * Pure line framing of the Python stdout transport (Python spec §7). Nothing here does I/O.
 *
 * A frame is a stdout line that STARTS with `\u001eALISIO-FORGE:<nonce>:` followed by JSON. Every
 * other byte of stdout is ordinary script output and is handed back unchanged, in order, as soon as
 * it is known not to be a frame (a plain line streams chunk by chunk; only a line that still looks
 * like the start of a frame is held). The nonce only tells frames from output: it grants nothing.
 */
import { MAX_MESSAGE_BYTES } from "../protocol.ts";

export const FRAME_MARK = "\u001eALISIO-FORGE:";

/** The longest frame body kept, in characters (a character is at least one byte of the cap). */
export const MAX_FRAME_CHARS = MAX_MESSAGE_BYTES + 512;

export type FrameEvent =
  | { type: "text"; text: string }
  | { type: "frame"; json: string }
  /** A frame line longer than the cap: its body was dropped. */
  | { type: "oversize" };

export const framePrefix = (nonce: string): string => `${FRAME_MARK}${nonce}:`;

type Mode = "start" | "text" | "frame" | "drop";

export class FrameDecoder {
  readonly #prefix: string;
  #mode: Mode = "start";
  /** Characters of the current line that matched the prefix so far (mode `start`). */
  #held = "";
  #body = "";

  constructor(nonce: string) {
    this.#prefix = framePrefix(nonce);
  }

  feed(chunk: string): FrameEvent[] {
    const events: FrameEvent[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      if (this.#mode === "text") {
        const newline = rest.indexOf("\n");
        if (newline < 0) {
          events.push({ type: "text", text: rest });
          return events;
        }
        events.push({ type: "text", text: rest.slice(0, newline + 1) });
        rest = rest.slice(newline + 1);
        this.#mode = "start";
      } else if (this.#mode === "drop") {
        const newline = rest.indexOf("\n");
        if (newline < 0) return events;
        rest = rest.slice(newline + 1);
        this.#mode = "start";
      } else if (this.#mode === "frame") {
        const newline = rest.indexOf("\n");
        this.#body += newline < 0 ? rest : rest.slice(0, newline);
        if (this.#body.length > MAX_FRAME_CHARS) {
          events.push({ type: "oversize" });
          this.#body = "";
          this.#mode = "drop";
          rest = newline < 0 ? "" : rest.slice(newline);
          continue;
        }
        if (newline < 0) return events;
        events.push({ type: "frame", json: this.#body.replace(/\r$/, "") });
        this.#body = "";
        this.#mode = "start";
        rest = rest.slice(newline + 1);
      } else rest = this.#start(rest, events);
    }
    return events;
  }

  /** The stream ended: whatever is held was never completed as a frame line. */
  flush(): FrameEvent[] {
    const events: FrameEvent[] = [];
    if (this.#mode === "start" && this.#held) events.push({ type: "text", text: this.#held });
    if (this.#mode === "frame" && this.#body)
      events.push({ type: "frame", json: this.#body.replace(/\r$/, "") });
    this.#mode = "start";
    this.#held = "";
    this.#body = "";
    return events;
  }

  /** Reads the beginning of a line; returns what is left of `rest` for the next mode. */
  #start(rest: string, events: FrameEvent[]): string {
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i] as string;
      if (ch === this.#prefix[this.#held.length]) {
        this.#held += ch;
        if (this.#held.length === this.#prefix.length) {
          this.#held = "";
          this.#mode = "frame";
          return rest.slice(i + 1);
        }
        continue;
      }
      // The line is ordinary output: release what matched and let the text mode stream the rest.
      if (this.#held) events.push({ type: "text", text: this.#held });
      this.#held = "";
      this.#mode = "text";
      return rest.slice(i);
    }
    return "";
  }
}

/** `text` without its frame lines (the form of stdout the model and the terminal see). */
export function stripFrames(text: string, nonce: string): string {
  const decoder = new FrameDecoder(nonce);
  return [...decoder.feed(text), ...decoder.flush()]
    .flatMap((event) => (event.type === "text" ? [event.text] : []))
    .join("");
}
