#!/bin/sh
# Alisio standalone installer: downloads the release binary for this OS/arch, verifies its
# SHA-256 against the release SHA256SUMS and installs it.
#   curl -fsSL https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/scripts/install.sh | sh
# Environment: ALISIO_VERSION (e.g. 0.1.0; default latest), ALISIO_INSTALL_DIR (default ~/.local/bin),
#              ALISIO_DOWNLOAD_BASE (mirror URL holding the assets and SHA256SUMS; skips the lookup)
set -eu

repo="GustavoGutierrez/alisio"
install_dir="${ALISIO_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "alisio-install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }
need curl
need uname

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) fail "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac
[ "$os" = windows ] && [ "$arch" != x64 ] && fail "only windows-x64 binaries are published"
ext=""; [ "$os" = windows ] && ext=".exe"
asset="alisio-$os-$arch$ext"

if [ -n "${ALISIO_DOWNLOAD_BASE:-}" ]; then
  tag="${ALISIO_VERSION:-mirror}"
elif [ -n "${ALISIO_VERSION:-}" ]; then
  tag="v${ALISIO_VERSION#v}"
else
  tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || fail "could not determine the latest release"
fi
base="${ALISIO_DOWNLOAD_BASE:-https://github.com/$repo/releases/download/$tag}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "Downloading $asset ($tag)..."
curl -fsSL "$base/$asset" -o "$tmp/$asset" || fail "download failed: $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)
[ -n "$expected" ] || fail "no checksum for $asset in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
else
  fail "need sha256sum or shasum to verify the download"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"

mkdir -p "$install_dir"
target="$install_dir/alisio$ext"
mv "$tmp/$asset" "$target"
chmod 755 "$target"
echo "Installed $target ($tag, sha256 verified)."
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to your PATH to run 'alisio'." ;;
esac
