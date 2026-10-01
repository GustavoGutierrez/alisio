/**
 * Install instructions for Python ≥ 3.10 on the machine Alisio runs on. A pure function of the
 * detected host (injected in tests); the host detection reads `/etc/os-release` and looks for
 * `uv`, `winget` and `brew` on PATH without launching any process. Commands are shown, never run.
 */
import { readFile } from "node:fs/promises";
import { which } from "../runtime/fs.ts";

export interface HintHost {
  platform: NodeJS.Platform;
  arch: string;
  /** Linux `/etc/os-release` fields (`ID`, `ID_LIKE`, `PRETTY_NAME`, `VERSION_ID`). */
  osRelease?: Record<string, string>;
  hasUv?: boolean;
  hasWinget?: boolean;
  hasBrew?: boolean;
  /** A Python that was found but is too old (or a `--python` that failed). */
  found?: { version?: string; path: string; reason?: string };
}

export interface InstallHints {
  /** `Linux · Ubuntu 22.04 · x86_64` */
  system: string;
  /** Optional heading line (found Python too old, `--python` not usable). */
  heading?: string;
  primary: string;
  alternatives: string[];
  notes: string[];
}

const UV = "uv python install 3.12";
const PYTHON_ORG = "Download the installer from https://www.python.org/downloads/";

/** Parses `KEY=value` / `KEY="value"` lines of an os-release file. */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match?.[1]) out[match[1]] = (match[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

function systemLabel(host: HintHost): string {
  const os =
    host.platform === "win32"
      ? "Windows"
      : host.platform === "darwin"
        ? "macOS"
        : host.platform === "linux"
          ? "Linux"
          : host.platform;
  const distro = host.osRelease?.PRETTY_NAME;
  return [os, distro, host.arch].filter(Boolean).join(" · ");
}

export function pythonInstallHints(host: HintHost): InstallHints {
  const system = systemLabel(host);
  const heading = host.found
    ? host.found.version
      ? `Found Python ${host.found.version} at ${host.found.path}; Alisio needs 3.10 or newer.`
      : `The Python at ${host.found.path} is not usable${host.found.reason ? ` (${host.found.reason})` : ""}.`
    : undefined;
  const notes: string[] = [];
  if (host.found)
    notes.push("If another Python 3.10+ is installed, start Alisio with --python <path>.");
  let primary: string;
  let alternatives: string[] = [];
  if (host.platform === "win32") {
    primary = "winget install Python.Python.3.12";
    alternatives = [`${PYTHON_ORG} (check "Add python.exe to PATH")`];
    if (host.hasUv) alternatives.push(UV);
    notes.push(
      "The Microsoft Store alias (WindowsApps\\python.exe) does not count as an installed Python.",
      "Open a new terminal after installing so the updated PATH is visible.",
    );
  } else if (host.platform === "darwin") {
    if (host.hasBrew) {
      primary = "brew install python@3.12";
      alternatives = [
        "Download the macOS installer from https://www.python.org/downloads/macos/",
        UV,
      ];
    } else {
      primary = "Download the macOS installer from https://www.python.org/downloads/macos/";
      alternatives = [
        UV,
        "xcode-select --install (Command Line Tools Python; it may be older than 3.10)",
      ];
    }
  } else if (host.platform === "linux") {
    const ids = `${host.osRelease?.ID ?? ""} ${host.osRelease?.ID_LIKE ?? ""}`.toLowerCase();
    const has = (id: string) => ids.split(/\s+/).includes(id);
    if (has("debian") || has("ubuntu")) {
      primary = "sudo apt install python3";
      alternatives = [`If your distribution ships a version older than 3.10: ${UV}`];
    } else if (has("fedora") || has("rhel") || has("centos")) {
      primary = "sudo dnf install python3";
      alternatives = [UV];
    } else if (has("arch")) {
      primary = "sudo pacman -S python";
    } else if (ids.includes("suse")) {
      primary = "sudo zypper install python3";
    } else if (has("alpine")) {
      primary = "sudo apk add python3";
    } else {
      primary = "Install python3 with your system package manager";
      alternatives = [UV];
    }
  } else {
    primary = "Install python3 with your system package manager";
    alternatives = [UV];
  }
  return { system, ...(heading ? { heading } : {}), primary, alternatives, notes };
}

/** One paragraph for the model and terminals (English, like every tool message). */
export function installHintsText(hints: InstallHints): string {
  const lines = [
    ...(hints.heading ? [hints.heading] : []),
    `Python 3.10+ was not found on this machine (${hints.system}). To install it: ${hints.primary}`,
    ...hints.alternatives.map((alternative) => `Alternatively: ${alternative}`),
    ...hints.notes,
    "After installing, ask again; no Alisio restart is needed. To use a specific interpreter, start Alisio with --python <path>.",
  ];
  return lines.join("\n");
}

/** The same guidance as Markdown (web and TUI render it as a `markdown` block). */
export function installHintsMarkdown(hints: InstallHints): string {
  return [
    "**Python 3.10+ is not available**",
    "",
    ...(hints.heading ? [hints.heading, ""] : []),
    `Detected system: ${hints.system}`,
    "",
    "```sh",
    hints.primary,
    "```",
    ...(hints.alternatives.length
      ? ["", "Alternatives:", ...hints.alternatives.map((a) => `- ${a}`)]
      : []),
    ...(hints.notes.length ? ["", ...hints.notes.map((n) => `- ${n}`)] : []),
    "",
    "After installing, ask again; no restart is needed. Start Alisio with `--python <path>` to pin an interpreter.",
  ].join("\n");
}

/** Detects the host for `pythonInstallHints` (reads files and PATH only; launches nothing). */
export async function detectHintHost(found?: HintHost["found"]): Promise<HintHost> {
  let osRelease: Record<string, string> | undefined;
  if (process.platform === "linux")
    osRelease = await readFile("/etc/os-release", "utf8")
      .then(parseOsRelease)
      .catch(() => undefined);
  const [uv, winget, brew] = await Promise.all([which("uv"), which("winget"), which("brew")]);
  return {
    platform: process.platform,
    arch: process.arch,
    ...(osRelease ? { osRelease } : {}),
    hasUv: !!uv,
    hasWinget: !!winget,
    hasBrew: !!brew,
    ...(found ? { found } : {}),
  };
}
