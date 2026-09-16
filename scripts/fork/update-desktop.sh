#!/usr/bin/env bash
# Installs the latest fork desktop build from GitHub Releases on this Mac.
#
# Usage: scripts/fork/update-desktop.sh [--tag fork-vX.Y.Z-fork.N] [--force] [--no-launch]
#
# Requires: Apple Silicon macOS, `gh` signed in to GitHub. The fork ships an
# unsigned zip; this script re-signs it ad hoc (Apple Silicon refuses to launch
# a bundle with no signature at all) and swaps it into /Applications.
# Quit T3 Code before running. Nothing here kills processes.
set -euo pipefail

REPO="${T3_FORK_REPO:-jpr98/t3code}"
APP_PATH="${T3_FORK_APP_PATH:-/Applications/T3 Code (Alpha).app}"
TAG=""
FORCE=0
LAUNCH=1

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --tag) TAG="${2:-}"; shift ;;
    --force) FORCE=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || die "this script is for macOS"
[[ "$(uname -m)" == "arm64" ]] || die "fork releases are built for Apple Silicon only"
command -v gh >/dev/null || die "install the GitHub CLI (brew install gh) and run: gh auth login"
gh auth status >/dev/null 2>&1 || die "GitHub CLI is not signed in. Run: gh auth login"

if [[ -z "$TAG" ]]; then
  TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
fi
VERSION="${TAG#fork-v}"

installed_version=""
if [[ -d "$APP_PATH" ]]; then
  installed_version="$(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
  # Match on the bundle path: pgrep -x does not see Electron's process name.
  app_pattern="$(printf '%s' "$APP_PATH/Contents/MacOS/" | sed 's/[][\.*^$()+?{}|\\]/\\&/g')"
  if pgrep -f "$app_pattern" >/dev/null; then
    die "$(basename "$APP_PATH") is running. Quit T3 Code, then run this again."
  fi
fi

if [[ "$installed_version" == "$VERSION" && "$FORCE" -eq 0 ]]; then
  echo "Already on $VERSION. Pass --force to reinstall."
  exit 0
fi

echo "Installing $VERSION (currently ${installed_version:-not installed})"

workdir="$(mktemp -d "${TMPDIR:-/tmp}/t3-fork-update.XXXXXX")"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

gh release download "$TAG" --repo "$REPO" --pattern '*-arm64.zip' --dir "$workdir/download"
shopt -s nullglob
zips=("$workdir"/download/*.zip)
(( ${#zips[@]} == 1 )) || die "expected one arm64 zip asset on $TAG, found ${#zips[@]}"

mkdir -p "$workdir/stage"
ditto -x -k "${zips[0]}" "$workdir/stage"
apps=("$workdir"/stage/*.app)
(( ${#apps[@]} == 1 )) || die "expected one .app inside the zip, found ${#apps[@]}"
app="${apps[0]}"

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
xattr -dr com.apple.quarantine "$app" 2>/dev/null || true

# Keep the previous install until the new one is in place.
previous=""
if [[ -d "$APP_PATH" ]]; then
  previous="$workdir/previous.app"
  mv "$APP_PATH" "$previous"
fi
if ! ditto "$app" "$APP_PATH"; then
  [[ -n "$previous" ]] && mv "$previous" "$APP_PATH"
  die "copy into $APP_PATH failed; previous install restored"
fi

echo "Installed $VERSION at $APP_PATH"
if (( LAUNCH )); then
  open -a "$APP_PATH"
fi
