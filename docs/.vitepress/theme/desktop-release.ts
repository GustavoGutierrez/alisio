/**
 * The Alisio Desktop release the docs home page links to. This is the ONE place to change when a
 * new release ships (see "Releasing Alisio Desktop" in docs/publishing.md).
 *
 * File names must match `artifactName` in apps/desktop/electron-builder.config.mjs.
 */
export const DESKTOP_VERSION = "0.11.5";

const REPOSITORY = "https://github.com/GustavoGutierrez/alisio";

export const DESKTOP_TAG = `v${DESKTOP_VERSION}`;
export const DESKTOP_RELEASE_URL = `${REPOSITORY}/releases/tag/${DESKTOP_TAG}`;

export type DesktopOs = "windows" | "macos" | "linux";

export interface DesktopAsset {
  id: string;
  os: DesktopOs;
  file: string;
  url: string;
}

const asset = (id: string, os: DesktopOs, file: string): DesktopAsset => ({
  id,
  os,
  file,
  url: `${REPOSITORY}/releases/download/${DESKTOP_TAG}/${file}`,
});

export const DESKTOP_ASSETS: DesktopAsset[] = [
  asset("windows-x64", "windows", `Alisio-Setup-${DESKTOP_VERSION}-x64.exe`),
  asset("macos-arm64", "macos", `Alisio-${DESKTOP_VERSION}-arm64.dmg`),
  asset("macos-x64", "macos", `Alisio-${DESKTOP_VERSION}-x64.dmg`),
  asset("linux-appimage", "linux", `Alisio-${DESKTOP_VERSION}-x86_64.AppImage`),
  asset("linux-deb", "linux", `Alisio-${DESKTOP_VERSION}-amd64.deb`),
];

/** Best-effort OS guess from a user agent; undefined when unsure (every OS stays listed). */
export function detectDesktopOs(userAgent: string): DesktopOs | undefined {
  if (/android|iphone|ipad|ipod/i.test(userAgent)) return undefined;
  if (/windows/i.test(userAgent)) return "windows";
  if (/macintosh|mac os x/i.test(userAgent)) return "macos";
  if (/linux|x11/i.test(userAgent)) return "linux";
  return undefined;
}
