# Publishing to npm

`pnpm publish` packs and publishes the Alisio packages to the public npm registry in
dependency-safe order (sdk → core → plugins → cli) so consumers never resolve a broken range
mid-publish. It applies the same leak checks as `pnpm pack:check` to every packed manifest.

## Quick path

```sh
pnpm publish -- --all --dry-run              # preview names, versions, tarballs and order
pnpm publish -- --all                        # build + publish every package (you enter the OTP)
pnpm publish -- --all --version 0.1.0-alpha.5 # bump every package to one version, then publish
pnpm publish -- --package cli                # publish only the CLI
```

`npm` prompts for the one-time password (OTP) interactively; the operator must enter it. Keys and
tokens live in your npm configuration, never in this script, and are never printed.

## Requirement: explicit selection

The default is **no publication**: you must pass `--all` or at least one `--package <name>`.
Unknown packages and unknown flags fail fast before anything is built or published.

| Flag | Meaning |
| --- | --- |
| `--all` | Every publishable package (`sdk`, `core`, `plugin-memory`, `plugin-subagents`, `plugin-openai-compatible`, `cli`) |
| `--package <name>` | One package, repeatable; combined with `--all` it is the union |
| `--version <v>` | Atomically set `<v>` in every selected `package.json` before packing (restores all files if any write fails, so a partial bump never ships) |
| `--dry-run` | Print exactly what would be published (names, versions, tarballs, order) and exit — no build, no bump, no pack, no publish |
| `--build` | Build first (`pnpm build`). ON by default; pass `--no-build` to skip |

## What it does and guarantees

1. Parses flags and resolves each package to `packages/<dir>`.
2. With `--version`: bumps every selected `package.json` atomically and prints the new version.
3. Builds (`pnpm build`) unless `--no-build`.
4. Packs each package with `pnpm pack` into a temporary directory and runs the pack-check leak
   check on the **packed** manifest (no `workspace:`, no `alisio-source`/`./src/` export,
   `exports` pointing at `./dist/`, not private).
5. Publishes each tarball with `npm publish <tarball> --access public` in dependency-safe order.
6. On any failure it stops, prints the failing `name@version`, and never silently skips or
   partially publishes the remaining packages; the exit code is non-zero.

Summary lines are printed as `==> name@version` before each publish.

## Checklist

- [ ] `pnpm publish -- --all --dry-run` lists exactly the packages you intend to publish
- [ ] `--version` matches the version in the CHANGELOG/release notes when bumping
- [ ] Core packages (`sdk`, `core`) are published before the plugins and the CLI
- [ ] The OTP is entered when npm prompts; nothing secret is printed by the script
- [ ] `pnpm pack:check` and `pnpm test` pass before publishing

## Next step

Run `pnpm publish -- --all --dry-run` first, then the real publish. See
[Known limitations](/limitations) for what has not been exercised against the real registry yet.