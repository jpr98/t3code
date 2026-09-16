# Fork release pipeline

Fork-only tooling. Nothing here is part of upstream T3 Code; the files live in
new paths so upstream syncs never conflict with them.

## What runs where

- `.github/workflows/fork-sync.yml` merges `pingdotgg/t3code` main into this
  fork's main every day at 09:00 UTC (one cron line to change) and on manual
  dispatch. A conflict or a failing server/web typecheck leaves main untouched
  and opens or updates an issue titled "Fork sync needs attention". A clean
  merge is pushed and the release workflow is dispatched explicitly, because a
  push made with the workflow token never triggers other workflows.
- `.github/workflows/fork-release.yml` runs on every push to main and on
  dispatch. It builds the Apple Silicon desktop app on `macos-15`, signs it ad
  hoc, and builds the server tarball on Ubuntu, then publishes both as the
  latest GitHub Release tagged `fork-v<version>`. Versions look like
  `0.0.41-fork.20260916.12`: upstream patch plus one, so the fork sorts above
  the upstream release it was built from, then date and run number.
- `scripts/fork/pack-server.mjs` turns `apps/server/dist` into the npm tarball
  the server hosts install. `pnpm pack` cannot do this because of workspace
  devDependencies.

## Updating an install

Mac, after quitting T3 Code:

```sh
curl -fsSL https://raw.githubusercontent.com/jpr98/t3code/main/scripts/fork/update-desktop.sh | bash
```

Server host running the systemd user service (the VPS):

```sh
curl -fsSL https://raw.githubusercontent.com/jpr98/t3code/main/scripts/fork/update-server.sh | bash
```

Both scripts accept `--tag fork-v...` to pin a release and `--force` to
reinstall the current version. The server script refuses to restart while a
turn is running, snapshots the database into `~/.t3-backups/`, and switches
back to the previous version if the new one does not come up.

## Things to know

- Never run `t3 service install`, `t3 service update`, or accept the client's
  "Update server" prompt on a fork host; they reinstall the official npm
  package.
- The desktop app has no Developer ID, so in-app auto-update stays off. Run the
  updater instead.
- GitHub disables scheduled workflows after 60 days without repository
  activity; a manual dispatch re-enables them.
- To rebuild a known-good commit, dispatch the release workflow from that ref
  with an explicit `version` input.
