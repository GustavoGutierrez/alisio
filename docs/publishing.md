# Publishing to npm

`pnpm publish` packs and publishes the Alisio packages to the public npm registry in
dependency-safe order (sdk → core → plugins and server → cli) so consumers never resolve a broken range
mid-publish. It applies the same leak checks as `pnpm pack:check` to every packed manifest.

## Quick path

```sh
pnpm publish -- --all --dry-run              # preview names, versions, tarballs and order
pnpm publish -- --all                        # build + publish every package (you enter the OTP)
pnpm publish -- --all --version 0.1.1        # bump every package to one stable version, then publish
pnpm publish -- --package cli                # publish only the CLI
```

`npm` prompts for the one-time password (OTP) interactively; the operator must enter it. Keys and
tokens live in your npm configuration, never in this script, and are never printed.

## Requirement: explicit selection

The default is **no publication**: you must pass `--all` or at least one `--package <name>`.
Unknown packages and unknown flags fail fast before anything is built or published.

| Flag | Meaning |
| --- | --- |
| `--all` | Every publishable package (`sdk`, `core`, `plugin-memory`, `plugin-subagents`, `plugin-openai-compatible`, `server`, `cli`) |
| `--package <name>` | One package, repeatable; combined with `--all` it is the union |
| `--version <v>` | Atomically set `<v>` (stable such as `0.1.1`, or a prerelease such as `0.2.0-rc.1`) in every selected `package.json` before packing (restores all files if any write fails, so a partial bump never ships) |
| `--dry-run` | Print exactly what would be published (names, versions, tarballs, order) and exit — no build, no bump, no pack, no publish |
| `--build` | Build first (`pnpm build`). ON by default; pass `--no-build` to skip |

## What it does and guarantees

1. Parses flags and resolves each package to `packages/<dir>`.
2. With `--version`: bumps every selected `package.json` atomically and prints the new version.
3. Builds (`pnpm build`) unless `--no-build`.
4. Packs each package with `pnpm pack` into a temporary directory and runs the pack-check leak
   check on the **packed** manifest (no `workspace:`, no `alisio-source`/`./src/` export,
   `exports` pointing at `./dist/`, not private).
5. Publishes each tarball with `npm publish <tarball> --access public` in dependency-safe order. A
   stable version is published with `--tag latest`; a prerelease passes no `--tag`, so npm applies
   its default tag (use a prerelease only when you do not mind it becoming `latest`, or publish it by hand
   with an explicit tag from a packed tarball).
6. On any failure it stops, prints the failing `name@version`, and never silently skips or
   partially publishes the remaining packages; the exit code is non-zero.

Summary lines are printed as `==> name@version` before each publish.

With `--all` the script refuses to publish when the packages are not all at one version: the seven
packages are released together.

## Stability and versioning

Alisio follows semver in its 0.x form:

- **Numbering.** All seven packages (`@alisio/sdk`, `@alisio/core`, `@alisio/server`,
  `@alisio/alisio-code`, `@alisio/plugin-memory`, `@alisio/plugin-subagents`,
  `@alisio/plugin-openai-compatible`) share one version. The first stable release is `0.1.0`.
  Fixes ship as `0.1.x`; features and anything that may break ship as `0.2.0`, `0.3.0`, and so on.
- **Prereleases are optional** and use `-rc.N` or `-alpha.N` (`0.2.0-rc.1`). `latest` is for stable
  versions only.
- **What counts as public API:** the `@alisio/sdk` contract (plugin hooks, tools, commands and
  events), the configuration file format, and the web/SSE protocol of `alisio serve`. SQLite
  migrations are forward-only: a newer Alisio upgrades your data, an older one may not read it.
  While 0.x, a minor release may change any of them; the changelog says so.
- **Plugins** declare `@alisio/sdk` as a peer dependency with `^0.2.0`, which accepts 0.2.x and not
  0.1.x or 0.3.0 (caret ranges on 0.x never cross a minor). A plugin that supports both lines declares
  `^0.1.0 || ^0.2.0`.
- **1.0.0** is planned for when the SDK, the config format and the event protocol are frozen. It
  will not be published before then, and from it on breaking changes require a major version.

## Release tag

After a successful publish and a verified install, tag the release commit:

```sh
git tag -a v0.1.0 -m "Alisio 0.1.0"
git push origin v0.1.0
```

Use the same version as the packages (`vX.Y.Z`). Tags are created by hand after the publish; the
script never tags, commits or pushes.

## Checklist

- [ ] `pnpm publish -- --all --dry-run` lists exactly the packages you intend to publish
- [ ] `--version` matches the version in the CHANGELOG/release notes when bumping
- [ ] Core packages (`sdk`, `core`) are published before the plugins, the server and the CLI
- [ ] The `CHANGELOG.md` entry for the version exists and `pnpm changelog:data` was run
- [ ] After publishing, `git tag -a vX.Y.Z` and `git push origin vX.Y.Z`
- [ ] The OTP is entered when npm prompts; nothing secret is printed by the script
- [ ] `pnpm pack:check` and `pnpm test` pass before publishing

## Next step

Run `pnpm publish -- --all --dry-run` first, then the real publish. See
[Known limitations](/limitations) for what has not been exercised against the real registry yet.