/**
 * Chromium-family browser detection (spec 026 D6): explicit setting, environment overrides, known
 * OS paths, then `PATH`. Nothing is downloaded. Same approach as the Evalua plugin's detector,
 * written here (never imported across repositories).
 */
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface BrowserDetection {
  path?: string;
  source: "setting" | "env" | "known-path" | "path" | "none";
  detail?: string;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => Promise<boolean>;
  /** `documents.chromiumPath`. */
  explicit?: string | undefined;
}

export const ENV_OVERRIDES = [
  "ALISIO_CHROME_PATH",
  "CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
] as const;

export function knownBrowserPaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    ];
  if (platform === "win32")
    return [
      "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles%\\Chromium\\Application\\chrome.exe",
      "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe",
      "%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe",
    ];
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/brave-browser",
    "/usr/bin/vivaldi",
  ];
}

export function pathBrowserNames(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe"];
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
    "vivaldi",
  ];
}

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const expandEnv = (path: string, env: NodeJS.ProcessEnv) =>
  path.replace(/%([^%]+)%/g, (_m, name: string) => env[name] ?? "");

export async function detectBrowser(
  overrides: Partial<DetectDeps> = {},
): Promise<BrowserDetection> {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const exists = overrides.exists ?? executable;
  if (overrides.explicit?.trim()) {
    const p = overrides.explicit.trim();
    return (await exists(p))
      ? { path: p, source: "setting" }
      : { source: "none", detail: "documents.chromiumPath does not point to an executable file" };
  }
  for (const name of ENV_OVERRIDES) {
    const v = env[name];
    if (v?.trim() && (await exists(v))) return { path: v, source: "env", detail: name };
  }
  for (const known of knownBrowserPaths(platform)) {
    const p = expandEnv(known, env);
    if (await exists(p)) return { path: p, source: "known-path" };
  }
  for (const name of pathBrowserNames(platform)) {
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
      const p = join(dir, name);
      if (await exists(p)) return { path: p, source: "path", detail: name };
    }
  }
  return { source: "none" };
}

/** Per-OS action shown when no browser is found (D16). */
export function installAdvice(platform: NodeJS.Platform = process.platform): string {
  const where =
    platform === "darwin"
      ? "install Google Chrome, Microsoft Edge or Chromium (for example `brew install --cask google-chrome`)"
      : platform === "win32"
        ? "install Google Chrome or Microsoft Edge (Edge ships with Windows 10 and 11)"
        : "install google-chrome, chromium or microsoft-edge with your package manager";
  return `${where}, or set \`documents.chromiumPath\` (or the ALISIO_CHROME_PATH environment variable) to a Chromium-family browser.`;
}
