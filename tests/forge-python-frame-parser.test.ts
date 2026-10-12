/**
 * The pure framing of the Python stdout transport (Python spec §7): which bytes of a script's
 * stdout are protocol frames and which are ordinary output.
 */
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "../packages/core/src/forge/protocol.ts";
import {
  FrameDecoder,
  type FrameEvent,
  framePrefix,
  MAX_FRAME_CHARS,
  stripFrames,
} from "../packages/core/src/forge/python/frame-parser.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const frame = (body: string, nonce = NONCE) => `${framePrefix(nonce)}${body}\n`;

/** Feeds the chunks in order and returns the text, the frames and the oversize count. */
function decode(chunks: string[], nonce = NONCE) {
  const decoder = new FrameDecoder(nonce);
  const events: FrameEvent[] = [];
  for (const chunk of chunks) events.push(...decoder.feed(chunk));
  events.push(...decoder.flush());
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    frames: events.flatMap((e) => (e.type === "frame" ? [e.json] : [])),
    oversize: events.filter((e) => e.type === "oversize").length,
  };
}

describe("FrameDecoder", () => {
  it("hands ordinary output back unchanged and in order", () => {
    const out = decode(["hello\n", "wor", "ld\n", "\n", "no newline at the end"]);
    expect(out).toEqual({ text: "hello\nworld\n\nno newline at the end", frames: [], oversize: 0 });
  });

  it("streams an ordinary line chunk by chunk instead of waiting for its newline", () => {
    const decoder = new FrameDecoder(NONCE);
    expect(decoder.feed("progress 10%")).toEqual([{ type: "text", text: "progress 10%" }]);
    expect(decoder.feed(" ... done\n")).toEqual([{ type: "text", text: " ... done\n" }]);
  });

  it("extracts a frame line and keeps the lines around it", () => {
    const out = decode([`before\n${frame('{"a":1}')}after\n`]);
    expect(out.frames).toEqual(['{"a":1}']);
    expect(out.text).toBe("before\nafter\n");
  });

  it("assembles a frame split across chunks, even inside the prefix and the nonce", () => {
    const whole = frame('{"split":true}');
    for (const cut of [1, 5, framePrefix(NONCE).length - 1, framePrefix(NONCE).length + 3]) {
      const out = decode([whole.slice(0, cut), whole.slice(cut)]);
      expect(out.frames).toEqual(['{"split":true}']);
      expect(out.text).toBe("");
    }
  });

  it("treats a frame with another nonce, or without one, as ordinary output", () => {
    const other = frame("{}", "ffffffffffffffffffffffffffffffff");
    const bare = "\u001eALISIO-FORGE:{}\n";
    const out = decode([`${other}${bare}`]);
    expect(out.frames).toEqual([]);
    expect(out.text).toBe(`${other}${bare}`);
  });

  it("only a line that STARTS with the prefix is a frame", () => {
    const line = `x${frame("{}")}`;
    expect(decode([line])).toEqual({ text: line, frames: [], oversize: 0 });
  });

  it("accepts CRLF line endings on a frame", () => {
    expect(decode([`${framePrefix(NONCE)}{"a":1}\r\n`]).frames).toEqual(['{"a":1}']);
  });

  it("drops the body of a frame over the cap, reports it once and resumes with the next line", () => {
    const huge = "x".repeat(MAX_FRAME_CHARS + 10);
    const out = decode([framePrefix(NONCE), huge.slice(0, 1000), huge.slice(1000), "\nnext\n"]);
    expect(out).toEqual({ text: "next\n", frames: [], oversize: 1 });
  });

  it("a frame exactly at the cap is still a frame", () => {
    const body = "y".repeat(MAX_FRAME_CHARS);
    expect(decode([frame(body)]).frames).toEqual([body]);
  });

  it("never holds a long ordinary line: it is released as text", () => {
    const long = "z".repeat(MAX_FRAME_CHARS * 2);
    const decoder = new FrameDecoder(NONCE);
    const events = decoder.feed(long);
    expect(events).toEqual([{ type: "text", text: long }]);
  });

  it("on end of stream, a held partial prefix is text and an unterminated frame is a frame", () => {
    expect(decode([framePrefix(NONCE).slice(0, 6)])).toEqual({
      text: framePrefix(NONCE).slice(0, 6),
      frames: [],
      oversize: 0,
    });
    expect(decode([`${framePrefix(NONCE)}{"last":1}`]).frames).toEqual(['{"last":1}']);
  });

  it("recognizes a frame that starts a chunk right after the newline that ended an ordinary line", () => {
    const decoder = new FrameDecoder(NONCE);
    const events = [...decoder.feed("ordinary"), ...decoder.feed(`\n${frame('{"a":1}')}`)];
    expect(events.filter((e) => e.type === "frame")).toEqual([{ type: "frame", json: '{"a":1}' }]);
  });

  it("an empty frame is reported as a frame (the host rejects it), not swallowed or merged", () => {
    expect(decode([`${framePrefix(NONCE)}\nnext\n`])).toEqual({
      text: "next\n",
      frames: [""],
      oversize: 0,
    });
  });

  it("the rest of an oversize frame is dropped wherever the chunks fall, and only that", () => {
    const huge = "x".repeat(MAX_FRAME_CHARS + 10);
    // all in one chunk, newline included
    expect(decode([`${framePrefix(NONCE)}${huge}\nnext\n`])).toEqual({
      text: "next\n",
      frames: [],
      oversize: 1,
    });
    // more junk of the same line arrives in a later chunk with no newline
    expect(decode([`${framePrefix(NONCE)}${huge}`, "more junk of the line", "\nnext\n"])).toEqual({
      text: "next\n",
      frames: [],
      oversize: 1,
    });
  });

  it("never refuses a message the protocol itself would accept", () => {
    const body = "z".repeat(MAX_MESSAGE_BYTES);
    expect(decode([frame(body)]).frames).toEqual([body]);
  });

  it("at the end of the stream there is nothing to flush when nothing is held", () => {
    for (const chunks of [["plain\n"], ["half a line"], [framePrefix(NONCE)], [frame("{}")]]) {
      const decoder = new FrameDecoder(NONCE);
      for (const chunk of chunks) decoder.feed(chunk);
      const flushed = decoder.flush();
      expect(
        flushed.filter((e) => e.type === "frame" || (e.type === "text" && e.text === "")),
      ).toEqual([]);
    }
    const drop = new FrameDecoder(NONCE);
    drop.feed(`${framePrefix(NONCE)}${"x".repeat(MAX_FRAME_CHARS + 1)}`);
    expect(drop.flush()).toEqual([]);
  });
});

describe("stripFrames", () => {
  it("removes the frame lines of a captured stdout and nothing else", () => {
    const raw = `a\n${frame('{"x":1}')}b\n${frame("{}", "other")}`;
    expect(stripFrames(raw, NONCE)).toBe(`a\nb\n${frame("{}", "other")}`);
  });

  it("is the identity on output without frames", () => {
    expect(stripFrames("plain\ntext", NONCE)).toBe("plain\ntext");
  });
});
