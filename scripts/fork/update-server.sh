#!/usr/bin/env bash
# Updates the fork server on a Linux host that runs T3 Code as the systemd user
# service installed by `t3 service install` (~/.t3/runtime/service-launcher.mjs).
#
# Usage: scripts/fork/update-server.sh [--tag fork-vX.Y.Z-fork.N] [--force] [--keep N]
#
# Flow: download the release tarball, npm-install it into a new version
# directory, snapshot the database, switch activeVersion, restart the service,
# and verify it came back. On failure it switches back to the previous version
# and restarts again. Aborts while a turn is running unless --force.
# Needs only curl, python3, tar, node/npm (found through the service unit).
set -euo pipefail

REPO="${T3_FORK_REPO:-jpr98/t3code}"
RUNTIME_DIR="${T3_RUNTIME_DIR:-$HOME/.t3/runtime}"
USERDATA_DIR="${T3_USERDATA_DIR:-$HOME/.t3/userdata}"
SERVICE="${T3_SERVICE_NAME:-t3code}"
BACKUP_ROOT="${T3_BACKUP_ROOT:-$HOME/.t3-backups}"
TAG=""
FORCE=0
KEEP=2

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --tag) TAG="${2:-}"; shift ;;
    --force) FORCE=1 ;;
    --keep) KEEP="${2:-2}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

for tool in curl python3 tar; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
done

STATE_FILE="$RUNTIME_DIR/service-state.json"
VERSIONS_DIR="$RUNTIME_DIR/versions"
[[ -f "$STATE_FILE" ]] || die "$STATE_FILE not found; is the T3 service installed on this host?"

# Use the same Node the service runs, so npm installs native modules for it.
exec_start="$(systemctl --user show -p ExecStart --value "$SERVICE" 2>/dev/null || true)"
node_bin="$(printf '%s' "$exec_start" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
if [[ -x "$node_bin" ]]; then
  export PATH="$(dirname "$node_bin"):$PATH"
fi
command -v npm >/dev/null || die "npm not found on PATH or beside the service's node"

api_headers=(-H "Accept: application/vnd.github+json")
if [[ -n "${GH_TOKEN:-}" ]]; then
  api_headers+=(-H "Authorization: Bearer $GH_TOKEN")
fi
if [[ -n "$TAG" ]]; then
  release_url="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  release_url="https://api.github.com/repos/$REPO/releases/latest"
fi
release_json="$(curl -fsSL "${api_headers[@]}" "$release_url")"
read -r TAG TARBALL_URL < <(python3 - "$release_json" <<'PY'
import json, sys
release = json.loads(sys.argv[1])
assets = [a for a in release.get("assets", []) if a["name"].endswith(".tgz")]
if len(assets) != 1:
    sys.exit(f"expected one .tgz asset on {release.get('tag_name')}, found {len(assets)}")
print(release["tag_name"], assets[0]["browser_download_url"])
PY
)
VERSION="${TAG#fork-v}"

active_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["activeVersion"])' "$STATE_FILE")"
if [[ "$active_version" == "$VERSION" && "$FORCE" -eq 0 ]]; then
  echo "Already on $VERSION. Pass --force to reinstall."
  exit 0
fi
echo "Updating $active_version -> $VERSION"

db="$USERDATA_DIR/state.sqlite"
if [[ -f "$db" ]]; then
  active_turns="$(python3 - "$db" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(conn.execute("select count(*) from projection_turns where state = 'running'").fetchone()[0])
PY
)"
  if [[ "$active_turns" != "0" && "$FORCE" -eq 0 ]]; then
    die "$active_turns turn(s) are running. Wait for them, or pass --force."
  fi
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/t3-fork-update.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

tarball="$workdir/t3-$VERSION.tgz"
curl -fL --retry 3 -o "$tarball" "$TARBALL_URL"

version_dir="$VERSIONS_DIR/$VERSION"
if [[ -d "$version_dir" ]]; then
  rm -rf "$version_dir"
fi
mkdir -p "$version_dir"
npm install --prefix "$version_dir" "$tarball" --omit=dev --no-audit --no-fund --loglevel=error
[[ -f "$version_dir/node_modules/t3/dist/bin.mjs" ]] || die "install did not produce node_modules/t3/dist/bin.mjs"
# The launcher refuses a version directory without this marker.
printf '%s\n' "$VERSION" > "$version_dir/.install-complete"

backup_dir="$BACKUP_ROOT/before-$VERSION-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
cp "$STATE_FILE" "$backup_dir/service-state.json"
if [[ -f "$db" ]]; then
  python3 - "$db" "$backup_dir/state.sqlite" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
conn.execute("VACUUM INTO ?", (sys.argv[2],))
PY
fi
echo "Backup written to $backup_dir"

set_active_version() {
  python3 - "$STATE_FILE" "$1" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    state = json.load(f)
state["activeVersion"] = version
with open(path, "w") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
PY
}

healthy() {
  local runtime_file="$USERDATA_DIR/server-runtime.json"
  [[ "$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)" == "active" ]] || return 1
  [[ -f "$runtime_file" && "$runtime_file" -nt "$STATE_FILE" ]] || return 1
  local origin
  origin="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("origin", ""))' "$runtime_file")"
  [[ -z "$origin" ]] || curl -fsS -o /dev/null --max-time 5 "$origin/" || return 1
}

wait_healthy() {
  local i
  for i in $(seq 1 30); do
    if healthy; then return 0; fi
    sleep 2
  done
  return 1
}

set_active_version "$VERSION"
systemctl --user restart "$SERVICE"
if wait_healthy; then
  echo "Server is up on $VERSION"
else
  echo "Server did not come back on $VERSION; reverting to $active_version" >&2
  journalctl --user -u "$SERVICE" -n 40 --no-pager >&2 || true
  set_active_version "$active_version"
  systemctl --user restart "$SERVICE"
  if wait_healthy; then
    die "reverted to $active_version. The $VERSION install stays in $version_dir for inspection."
  fi
  die "revert to $active_version also failed; check: systemctl --user status $SERVICE"
fi

# Prune old version directories, keeping the new one, the previous one, and
# the KEEP most recently modified others.
keep_list="$(printf '%s\n%s\n' "$VERSION" "$active_version")"
ls -1t "$VERSIONS_DIR" | grep -vxF -f <(printf '%s\n' "$keep_list") | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "Removing old version $old"
  rm -rf "${VERSIONS_DIR:?}/$old"
done
