import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  cannotOpenMessage,
  desktopAvailable,
  openCommands,
  openPath,
  revealCommands,
  revealPath,
} from "../packages/cli/src/tui/open-path.ts";

/** A spawn stub: records launches; `missing` commands fail like ENOENT. */
function spawner(missing: string[] = []) {
  const launches: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawn = (command: string, args: string[], options: unknown) => {
    launches.push({ command, args, options: options as Record<string, unknown> });
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    queueMicrotask(() =>
      missing.includes(command)
        ? child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))
        : child.emit("spawn"),
    );
    return child as never;
  };
  return { spawn, launches };
}

describe("open-path commands", () => {
  it("builds xdg-open / open / explorer.exe and never a shell", () => {
    expect(openCommands("/a b/ñ.pdf", "linux")[0]).toEqual({
      command: "xdg-open",
      args: ["/a b/ñ.pdf"],
    });
    expect(openCommands("/a.pdf", "darwin")).toEqual([{ command: "open", args: ["/a.pdf"] }]);
    expect(openCommands("C:\\a b\\x.pdf", "win32")).toEqual([
      { command: "explorer.exe", args: ["C:\\a b\\x.pdf"] },
    ]);
    expect(revealCommands("/x/y/z.md", "linux")[0]).toEqual({
      command: "xdg-open",
      args: ["/x/y"],
    });
    expect(revealCommands("/x/z.md", "darwin")).toEqual([
      { command: "open", args: ["-R", "/x/z.md"] },
    ]);
    expect(revealCommands("C:\\x\\z.md", "win32")).toEqual([
      { command: "explorer.exe", args: ["/select,C:\\x\\z.md"] },
    ]);
    for (const platform of ["linux", "darwin", "win32"] as const)
      for (const launch of [...openCommands("/p", platform), ...revealCommands("/p", platform)])
        expect(["cmd", "cmd.exe", "sh", "/bin/sh", "bash"]).not.toContain(launch.command);
  });

  it("launches detached without a shell and falls back to gio when xdg-open is missing", async () => {
    const stub = spawner(["xdg-open"]);
    const outcome = await openPath("/f.md", {
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawn: stub.spawn,
    });
    expect(outcome).toEqual({ ok: true });
    expect(stub.launches.map((l) => l.command)).toEqual(["xdg-open", "gio"]);
    expect(stub.launches[1]?.options).toMatchObject({
      shell: false,
      detached: true,
      stdio: "ignore",
    });
  });

  it("over SSH or without a display launches nothing and explains", async () => {
    const stub = spawner();
    const ssh = await openPath("/f.md", {
      platform: "linux",
      env: { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" },
      spawn: stub.spawn,
    });
    expect(ssh).toEqual({ ok: false, reason: "no-desktop" });
    expect(await revealPath("/f.md", { platform: "linux", env: {}, spawn: stub.spawn })).toEqual({
      ok: false,
      reason: "no-desktop",
    });
    expect(stub.launches).toEqual([]);
    expect(cannotOpenMessage("/f.md", { ok: false, reason: "no-desktop" })).toBe(
      "Can't open files here (no desktop session). Path: /f.md",
    );
    expect(desktopAvailable("darwin", {})).toBe(true);
    expect(desktopAvailable("win32", { SSH_TTY: "/dev/pts/1" })).toBe(false);
  });

  it("reports unavailable when no opener exists", async () => {
    const stub = spawner(["xdg-open", "gio"]);
    expect(
      await openPath("/f.md", {
        platform: "linux",
        env: { WAYLAND_DISPLAY: "w" },
        spawn: stub.spawn,
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});
