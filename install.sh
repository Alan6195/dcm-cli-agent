#!/usr/bin/env bash
#
# Installs the NewLumen DICOM CLI Agent (dcm) for the current user.
#
# Downloads the latest release binary for this platform, verifies it against the
# published SHA256SUMS.txt, and installs it to ~/.local/bin. Nothing is written
# outside the home directory and sudo is never needed.
#
#   curl -fsSL https://raw.githubusercontent.com/Alan6195/dcm-cli-agent/master/install.sh | bash
#
set -euo pipefail

REPO="${DCM_REPO:-Alan6195/dcm-cli-agent}"
VERSION="${DCM_VERSION:-latest}"
INSTALL_DIR="${DCM_INSTALL_DIR:-$HOME/.local/bin}"

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m  %s\033[0m\n' "$1"; }
step() { printf '\033[36m  %s\033[0m\n' "$1"; }
die()  { printf '\033[31m  error: %s\033[0m\n' "$1" >&2; exit 1; }

echo
cyan "  NewLumen DICOM CLI Agent - installer"
echo

# --- Which binary does this machine need? ------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64)  asset="dcm-macos-arm64" ;;
      x86_64) asset="dcm-macos-x64" ;;
      *) die "unsupported macOS architecture: $arch" ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64|amd64) asset="dcm-linux-x64" ;;
      *) die "unsupported Linux architecture: $arch. Build from source: npm install && npm run build" ;;
    esac
    ;;
  *)
    die "unsupported platform: $os. On Windows use install.ps1."
    ;;
esac

dim "platform: $os $arch -> $asset"

command -v curl >/dev/null 2>&1 || die "curl is required"

# --- Resolve the release ------------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  api="https://api.github.com/repos/$REPO/releases/latest"
else
  api="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi

step "Looking up the $VERSION release of $REPO"
release_json="$(curl -fsSL -H 'User-Agent: dcm-installer' "$api")" \
  || die "could not reach the GitHub release API"

tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$tag" ] || die "could not determine the release tag"
dim "found $tag"

url="https://github.com/$REPO/releases/download/$tag/$asset"

# --- Download -----------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

step "Downloading $asset"
curl -fsSL "$url" -o "$tmp/$asset" || die "download failed: $url"

# --- Verify -------------------------------------------------------------------
sums_url="https://github.com/$REPO/releases/download/$tag/SHA256SUMS.txt"
if curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS.txt" 2>/dev/null; then
  step "Verifying checksum"
  expected="$(grep "$asset" "$tmp/SHA256SUMS.txt" | awk '{print $1}' | head -1)"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
    fi
    [ "$actual" = "$expected" ] || die "checksum mismatch: expected $expected, got $actual. Not installing."
    dim "OK  $actual"
  fi
else
  dim "no SHA256SUMS.txt for this release; skipping verification"
fi

# --- Install ------------------------------------------------------------------
step "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
install -m 755 "$tmp/$asset" "$INSTALL_DIR/dcm" 2>/dev/null \
  || { cp "$tmp/$asset" "$INSTALL_DIR/dcm" && chmod 755 "$INSTALL_DIR/dcm"; }

# macOS quarantines anything downloaded, and an unsigned binary is then killed
# on sight with a message that says nothing useful. Clear the attribute here
# rather than leaving people to discover it.
if [ "$os" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/dcm" 2>/dev/null || true
fi

echo
printf '\033[32m  Installed.\033[0m\n'
echo

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "  Try it:"
    ;;
  *)
    printf '\033[33m  %s is not on your PATH.\033[0m\n' "$INSTALL_DIR"
    echo "  Add this to your shell profile (~/.zshrc, ~/.bashrc):"
    echo
    printf '\033[36m      export PATH="%s:$PATH"\033[0m\n' "$INSTALL_DIR"
    echo
    echo "  Then, in a new shell:"
    ;;
esac

echo
printf '\033[36m      dcm\033[0m                       interactive menu\n'
printf '\033[36m      dcm --help\033[0m                full command reference\n'
printf '\033[36m      dcm info /path/to/study\033[0m\n'
echo
