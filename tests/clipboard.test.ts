import { describe, expect, it } from "vitest";
import { clipboardCommands, copyText, osc52 } from "../packages/cli/src/tui/clipboard.ts";

type Call = { command: string; args: string[]; input: string };
const spawner = (results: Record<string, number | "missing">) => {
  const calls: Call[] = [];
  const spawn = async (command: string, args: string[], input: string) => {
    calls.push({ command, args, input });
    const result = results[command] ?? "missing";
    if (result === "missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return result;
  };
  return { calls, spawn };
};

describe("clipboard command selection", () => {
  it("orders native tools per platform", () => {
    expect(clipboardCommands("linux", {}).map((c) => c.command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
    expect(clipboardCommands("linux", { WSL_DISTRO_NAME: "Ubuntu" }).map((c) => c.command)).toEqual(
      ["wl-copy", "xclip", "xsel", "clip.exe", "powershell.exe"],
    );
    expect(clipboardCommands("darwin", {}).map((c) => c.command)).toEqual(["pbcopy"]);
    expect(clipboardCommands("win32", {}).map((c) => c.command)).toEqual([
      "clip.exe",
      "powershell.exe",
    ]);
    expect(clipboardCommands("linux", {}).find((c) => c.command === "xclip")?.args).toEqual([
      "-selection",
      "clipboard",
    ]);
    expect(clipboardCommands("linux", {}).find((c) => c.command === "xsel")?.args).toEqual(["-b"]);
  });

  it("uses the first tool that exits 0, passing text on stdin without a shell", async () => {
    const { calls, spawn } = spawner({ "wl-copy": 1, xclip: 0, xsel: 0 });
    const writes: string[] = [];
    const result = await copyText("héllo", {
      platform: "linux",
      env: {},
      spawn,
      writeOsc52: (s) => writes.push(s),
    });
    expect(result).toEqual({ ok: true, method: "xclip" });
    expect(calls.map((c) => c.command)).toEqual(["wl-copy", "xclip"]);
    expect(calls.every((c) => c.input === "héllo")).toBe(true);
    expect(writes).toEqual([]);
  });

  it("falls back to OSC 52 and reports it is unverified when no tool works", async () => {
    const { calls, spawn } = spawner({ xsel: 2 });
    const writes: string[] = [];
    const result = await copyText("abc", {
      platform: "linux",
      env: {},
      spawn,
      writeOsc52: (s) => writes.push(s),
    });
    expect(result).toEqual({ ok: false, method: "osc52" });
    expect(calls).toHaveLength(3);
    expect(writes).toEqual([osc52("abc")]);
    expect(osc52("abc")).toBe("\x1b]52;c;YWJj\x07");
  });

  it("reports failure when neither native tools nor OSC 52 are available", async () => {
    const { spawn } = spawner({});
    expect(await copyText("x", { platform: "darwin", env: {}, spawn })).toEqual({
      ok: false,
      method: "none",
    });
  });
});
