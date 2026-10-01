import { describe, expect, it } from "vitest";
import {
  installHintsText,
  parseOsRelease,
  pythonInstallHints,
} from "../packages/core/src/analysis/install-hints.ts";

const linux = (release: string) => ({
  platform: "linux" as const,
  arch: "x64",
  osRelease: parseOsRelease(release),
});

describe("pythonInstallHints", () => {
  it.each([
    ['ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 22.04.5 LTS"', "sudo apt install python3"],
    ["ID=debian", "sudo apt install python3"],
    ['ID=fedora\nPRETTY_NAME="Fedora Linux 40"', "sudo dnf install python3"],
    ['ID="rocky"\nID_LIKE="rhel centos fedora"', "sudo dnf install python3"],
    ["ID=arch", "sudo pacman -S python"],
    ['ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"', "sudo zypper install python3"],
    ["ID=alpine", "sudo apk add python3"],
    ["ID=nixos", "Install python3 with your system package manager"],
  ])("Linux %j → %s", (release, primary) => {
    expect(pythonInstallHints(linux(release)).primary).toBe(primary);
  });

  it("names the detected distribution and architecture", () => {
    const hints = pythonInstallHints(
      linux('ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 22.04.5 LTS"'),
    );
    expect(hints.system).toBe("Linux · Ubuntu 22.04.5 LTS · x64");
    expect(installHintsText(hints)).toContain(
      "Python 3.10+ was not found on this machine (Linux · Ubuntu 22.04.5 LTS · x64)",
    );
  });

  it("Windows: winget first, warns about the Store alias and the new terminal", () => {
    const hints = pythonInstallHints({ platform: "win32", arch: "x64", hasUv: true });
    expect(hints.primary).toBe("winget install Python.Python.3.12");
    expect(hints.alternatives.join("\n")).toContain("Add python.exe to PATH");
    expect(hints.alternatives).toContain("uv python install 3.12");
    expect(hints.notes.join("\n")).toMatch(/Microsoft Store alias/);
    expect(hints.notes.join("\n")).toMatch(/new terminal/);
  });

  it("macOS with and without Homebrew", () => {
    expect(pythonInstallHints({ platform: "darwin", arch: "arm64", hasBrew: true }).primary).toBe(
      "brew install python@3.12",
    );
    const bare = pythonInstallHints({ platform: "darwin", arch: "arm64", hasBrew: false });
    expect(bare.primary).toContain("python.org/downloads/macos");
    expect(bare.alternatives.join("\n")).toContain("xcode-select --install");
  });

  it("heads the guidance with the too-old Python that was found", () => {
    const hints = pythonInstallHints({
      ...linux("ID=debian"),
      found: { version: "3.8.10", path: "/usr/bin/python3" },
    });
    expect(hints.heading).toBe(
      "Found Python 3.8.10 at /usr/bin/python3; Alisio needs 3.10 or newer.",
    );
    expect(installHintsText(hints)).toContain("--python <path>");
  });
});
