/** @type {import("electron-builder").Configuration} */
export default {
  appId: "dev.alisio.desktop",
  productName: "Alisio",
  executableName: "alisio",
  // Fallback only: every target below sets its own stable, human-friendly name, which the download
  // links on the docs home page depend on (docs/.vitepress/theme/desktop-release.ts).
  artifactName: "Alisio-${version}-${arch}.${ext}",
  asar: true,
  directories: { output: "release", buildResources: "build-resources" },
  // The Electron main code only: dist/*.js. The host and its node_modules live in
  // resources/runtime (outside the asar) because workers spawn real files.
  files: ["dist/**/*", "package.json", "build-resources/icon.png", "!**/*.map", "!node_modules/**"],
  npmRebuild: false,
  // resources/runtime is copied by scripts/after-pack.mjs (extraResources drops node_modules).
  afterPack: "./scripts/after-pack.mjs",
  publish: null,
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Office",
    // A set of standard sizes: the hicolor theme ignores a lone 1024x1024 icon, so launchers and
    // docks would fall back to a generic one. macOS and Windows keep using icon.png.
    icon: "icons",
    // Matches package.json desktopName, which Electron uses as WM_CLASS, so the dock links the window to this entry and its icon.
    syncDesktopName: true,
    maintainer: "Gustavo Gutiérrez <noreply@users.noreply.github.com>",
  },
  appImage: { artifactName: "Alisio-${version}-x86_64.AppImage" },
  deb: { packageName: "alisio", artifactName: "Alisio-${version}-amd64.deb" },
  win: { target: [{ target: "nsis", arch: ["x64"] }], icon: "icon.png" },
  // Assisted installer: NSIS 3 + Modern UI 2 wizard (welcome, folder, progress, finish).
  // Per-user by default, so no administrator rights are needed.
  nsis: {
    artifactName: "Alisio-Setup-${version}-x64.exe",
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Alisio",
    uninstallDisplayName: "Alisio",
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    multiLanguageInstaller: true,
    installerLanguages: ["es_ES", "en_US"],
  },
  // Unsigned distribution: no Apple Developer certificate and no notarization. Ad-hoc signing
  // (`identity: "-"`) is still required, because Apple Silicon refuses to run a completely
  // unsigned arm64 app. Hardened runtime stays off: with an ad-hoc signature it enforces library
  // validation and would reject the pre-signed Electron frameworks.
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    category: "public.app-category.productivity",
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    icon: "icon.png",
  },
  dmg: { artifactName: "Alisio-${version}-${arch}.dmg" },
};
