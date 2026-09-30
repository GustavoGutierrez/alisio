import { describe, expect, it } from "vitest";
import {
  childPath,
  directoryParent,
  directorySegments,
  isBrowsablePath,
} from "../packages/server/src/host/dir-listing.ts";
import {
  createNativePicker,
  findOnPath,
  type PickerRun,
  parsePickerOutput,
  pickerCommand,
  selectPicker,
} from "../packages/server/src/host/folder-picker.ts";

/** A fake filesystem: `exists(file)` is true only for the listed executables. */
const files = (...paths: string[]) => {
  const set = new Set(paths);
  return async (file: string) => set.has(file);
};

describe("portable PATH lookup", () => {
  it("scans PATH with the POSIX delimiter and returns the first match", async () => {
    const found = await findOnPath("zenity", {
      platform: "linux",
      env: { PATH: "/opt/bin:/usr/bin:/bin" },
      exists: files("/usr/bin/zenity", "/bin/zenity"),
    });
    expect(found).toBe("/usr/bin/zenity");
  });

  it("uses ; and PATHEXT on Windows (Path is case-insensitive there)", async () => {
    const found = await findOnPath("powershell", {
      platform: "win32",
      env: {
        Path: "C:\\Tools;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
        PATHEXT: ".COM;.EXE;.BAT",
      },
      exists: files("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE"),
    });
    expect(found).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE");
  });

  it("returns undefined when nothing matches or PATH is empty", async () => {
    expect(
      await findOnPath("yad", { platform: "linux", env: {}, exists: files("/usr/bin/yad") }),
    ).toBeUndefined();
    expect(
      await findOnPath("yad", { platform: "linux", env: { PATH: "/bin" }, exists: files() }),
    ).toBeUndefined();
  });
});

describe("picker strategy per platform", () => {
  const linuxEnv = { PATH: "/usr/bin", DISPLAY: ":0" };

  it("linux: first of zenity, kdialog, yad found on PATH, only with a display", async () => {
    expect(
      await selectPicker({
        platform: "linux",
        env: linuxEnv,
        exists: files("/usr/bin/kdialog", "/usr/bin/yad"),
      }),
    ).toEqual({ tool: "kdialog", file: "/usr/bin/kdialog", platform: "linux" });
    expect(
      await selectPicker({
        platform: "linux",
        env: { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" },
        exists: files("/usr/bin/zenity", "/usr/bin/kdialog"),
      }),
    ).toMatchObject({ tool: "zenity" });
    // Headless (SSH, CI): no display, no dialog.
    expect(
      await selectPicker({
        platform: "linux",
        env: { PATH: "/usr/bin" },
        exists: files("/usr/bin/zenity"),
      }),
    ).toBeUndefined();
    expect(
      await selectPicker({ platform: "linux", env: linuxEnv, exists: files() }),
    ).toBeUndefined();
  });

  it("darwin: osascript (from PATH or its fixed location)", async () => {
    expect(await selectPicker({ platform: "darwin", env: { PATH: "" }, exists: files() })).toEqual({
      tool: "osascript",
      file: "/usr/bin/osascript",
      platform: "darwin",
    });
  });

  it("win32: powershell.exe, else pwsh, else the system PowerShell path", async () => {
    expect(
      await selectPicker({
        platform: "win32",
        env: { Path: "C:\\PS7", PATHEXT: ".EXE" },
        exists: files("C:\\PS7\\pwsh.EXE"),
      }),
    ).toEqual({ tool: "powershell", file: "C:\\PS7\\pwsh.EXE", platform: "win32" });
    expect(
      await selectPicker({
        platform: "win32",
        env: { Path: "", SystemRoot: "D:\\Win" },
        exists: files("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
      }),
    ).toMatchObject({ file: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
  });

  it("can be switched off with ALISIO_NATIVE_PICKER=0 and is unknown elsewhere", async () => {
    expect(
      await selectPicker({
        platform: "linux",
        env: { ...linuxEnv, ALISIO_NATIVE_PICKER: "0" },
        exists: files("/usr/bin/zenity"),
      }),
    ).toBeUndefined();
    expect(
      await selectPicker({ platform: "aix", env: linuxEnv, exists: files("/usr/bin/zenity") }),
    ).toBeUndefined();
  });
});

describe("dialog commands (fixed arguments, no shell)", () => {
  it("zenity/yad/kdialog take the title and a validated start directory as arguments", () => {
    const zenity = pickerCommand(
      { tool: "zenity", file: "/usr/bin/zenity", platform: "linux" },
      { title: "Open", start: "/home/me" },
    );
    expect(zenity).toEqual({
      file: "/usr/bin/zenity",
      args: ["--file-selection", "--directory", "--title=Open", "--filename=/home/me/"],
    });
    expect(
      pickerCommand({ tool: "kdialog", file: "kdialog", platform: "linux" }, { title: "Open" })
        .args,
    ).toEqual(["--getexistingdirectory", "--title", "Open"]);
    expect(
      pickerCommand(
        { tool: "yad", file: "yad", platform: "linux" },
        { title: "Open", start: "/srv" },
      ).args,
    ).toEqual(["--file", "--directory", "--title=Open", "--filename=/srv/"]);
  });

  it("osascript passes title and start as argv, never interpolated into the script", () => {
    const command = pickerCommand(
      { tool: "osascript", file: "/usr/bin/osascript", platform: "darwin" },
      { title: 'Say "hi"', start: "/Users/me" },
    );
    const script = command.args.filter((_, i) => command.args[i - 1] === "-e").join("\n");
    expect(script).toContain("choose folder");
    expect(script).toContain("POSIX path of");
    expect(script).not.toContain("hi");
    expect(command.args.slice(-2)).toEqual(['Say "hi"', "/Users/me"]);
  });

  it("PowerShell runs a fixed -STA script and reads title/start from the environment", () => {
    const command = pickerCommand(
      { tool: "powershell", file: "powershell.exe", platform: "win32" },
      { title: "Abrir", start: "C:\\Users\\me" },
    );
    expect(command.args.slice(0, 3)).toEqual(["-NoProfile", "-STA", "-Command"]);
    const script = command.args[3] ?? "";
    expect(script).toContain("FolderBrowserDialog");
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
    expect(script).toContain("BrowseForFolder");
    expect(script).not.toContain("Abrir");
    expect(command.env).toEqual({
      ALISIO_PICKER_TITLE: "Abrir",
      ALISIO_PICKER_START: "C:\\Users\\me",
    });
  });
});

describe("dialog output parsing", () => {
  it("normalizes a chosen folder per platform", () => {
    expect(parsePickerOutput("linux", { code: 0, stdout: "/home/me/project\n" })).toEqual({
      path: "/home/me/project",
    });
    expect(parsePickerOutput("darwin", { code: 0, stdout: "/Users/me/Code/app/\n" })).toEqual({
      path: "/Users/me/Code/app",
    });
    expect(parsePickerOutput("darwin", { code: 0, stdout: "/\n" })).toEqual({ path: "/" });
    expect(parsePickerOutput("win32", { code: 0, stdout: "C:\\Users\\me\\Código\\\r\n" })).toEqual({
      path: "C:\\Users\\me\\Código",
    });
    expect(parsePickerOutput("win32", { code: 0, stdout: "D:\\\r\n" })).toEqual({ path: "D:\\" });
    expect(parsePickerOutput("win32", { code: 0, stdout: "C:/mixed/seps" })).toEqual({
      path: "C:\\mixed\\seps",
    });
  });

  it("detects cancellation: exit 1, osascript -128, yad close, empty PowerShell output", () => {
    const cancelled = { cancelled: true };
    expect(parsePickerOutput("linux", { code: 1, stdout: "" })).toEqual(cancelled);
    expect(
      parsePickerOutput("darwin", { code: 1, stdout: "", stderr: "User canceled. (-128)" }),
    ).toEqual(cancelled);
    expect(parsePickerOutput("linux", { code: 252, stdout: "" })).toEqual(cancelled);
    expect(parsePickerOutput("win32", { code: 0, stdout: "\r\n" })).toEqual(cancelled);
    expect(parsePickerOutput("linux", { code: null, stdout: "", timedOut: true })).toEqual(
      cancelled,
    );
  });

  it("reports failures and relative output as errors", () => {
    expect(parsePickerOutput("linux", { code: 2, stdout: "", stderr: "no display" })).toEqual({
      error: expect.stringContaining("no display"),
    });
    expect(parsePickerOutput("linux", { code: 0, stdout: "relative/dir" })).toMatchObject({
      error: expect.any(String),
    });
  });
});

describe("native picker runner", () => {
  it("runs the command once at a time and maps its outcome", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    let release!: () => void;
    const run: PickerRun = (file, args) => {
      calls.push({ file, args });
      return new Promise((resolve) => {
        release = () => resolve({ code: 0, stdout: "/picked\n", stderr: "" });
      });
    };
    const picker = createNativePicker({
      strategy: { tool: "zenity", file: "/usr/bin/zenity", platform: "linux" },
      run,
    });
    expect(await picker.available()).toBe(true);
    const first = picker.pick({ title: "Open" });
    expect(picker.busy).toBe(true);
    await expect(picker.pick({ title: "Open" })).rejects.toMatchObject({ code: "picker_busy" });
    release();
    expect(await first).toEqual({ path: "/picked" });
    expect(picker.busy).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("is unavailable without a strategy", async () => {
    const picker = createNativePicker({ strategy: undefined });
    expect(await picker.available()).toBe(false);
    await expect(picker.pick({ title: "x" })).rejects.toMatchObject({
      code: "picker_unavailable",
    });
  });
});

describe("folder browser paths", () => {
  it("builds POSIX breadcrumbs and parents", () => {
    expect(directorySegments("/home/me/src", "linux")).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
      { name: "src", path: "/home/me/src" },
    ]);
    expect(directoryParent("/home/me", "linux")).toBe("/home");
    expect(directoryParent("/", "linux")).toBeUndefined();
    expect(childPath("/", "etc", "linux")).toBe("/etc");
    expect(childPath("/home", "me", "darwin")).toBe("/home/me");
  });

  it("builds Windows breadcrumbs with drive roots and the drive list as the top", () => {
    expect(directorySegments("C:\\Users\\me", "win32")).toEqual([
      { name: "C:\\", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "me", path: "C:\\Users\\me" },
    ]);
    expect(directoryParent("C:\\Users", "win32")).toBe("C:\\");
    // Above a drive root is the drive list ("").
    expect(directoryParent("C:\\", "win32")).toBe("");
    expect(directoryParent("", "win32")).toBeUndefined();
    expect(directorySegments("", "win32")).toEqual([]);
    expect(childPath("C:\\", "Users", "win32")).toBe("C:\\Users");
    expect(childPath("", "D:\\", "win32")).toBe("D:\\");
  });

  it("accepts only absolute paths (and the Windows drive list)", () => {
    expect(isBrowsablePath("/tmp", "linux")).toBe(true);
    expect(isBrowsablePath("tmp", "linux")).toBe(false);
    expect(isBrowsablePath("C:\\Users", "win32")).toBe(true);
    expect(isBrowsablePath("", "win32")).toBe(true);
    expect(isBrowsablePath("", "linux")).toBe(false);
    expect(isBrowsablePath("Users", "win32")).toBe(false);
  });
});
