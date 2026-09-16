#!/usr/bin/env node
// Builds the npm tarball for the fork server from apps/server/dist.
//
// `pnpm pack` refuses apps/server because its devDependencies use the
// workspace: protocol. The bundle in dist/ has already inlined those, so the
// tarball only needs the runtime dependencies, pinned to the versions that were
// installed when the bundle was built (the bundle externalizes exactly those).
//
// Usage: node scripts/fork/pack-server.mjs [--version <v>] [--out <dir>]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const serverDir = NodePath.join(repoRoot, "apps/server");
const distDir = NodePath.join(serverDir, "dist");
const outDir = NodePath.resolve(repoRoot, option("out") ?? "release");

if (!NodeFS.existsSync(NodePath.join(distDir, "bin.mjs"))) {
  console.error("apps/server/dist/bin.mjs is missing. Run `vp run --filter t3 build` first.");
  process.exit(1);
}

const source = JSON.parse(NodeFS.readFileSync(NodePath.join(serverDir, "package.json"), "utf8"));
const version = option("version") ?? source.version;

const dependencies = Object.fromEntries(
  Object.keys(source.dependencies ?? {}).map((name) => {
    const installedPackageJson = NodePath.join(serverDir, "node_modules", name, "package.json");
    if (!NodeFS.existsSync(installedPackageJson)) {
      console.error(`Dependency ${name} is not installed under apps/server/node_modules.`);
      process.exit(1);
    }
    const installed = JSON.parse(NodeFS.readFileSync(installedPackageJson, "utf8"));
    return [name, installed.version];
  }),
);

const manifest = {
  name: source.name,
  version,
  license: source.license,
  repository: source.repository,
  bin: source.bin,
  files: ["dist"],
  type: source.type,
  engines: source.engines,
  dependencies,
};

const stageRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-pack-"));
try {
  // npm tarballs carry a top-level package/ directory.
  const packageDir = NodePath.join(stageRoot, "package");
  NodeFS.mkdirSync(packageDir);
  NodeFS.cpSync(distDir, NodePath.join(packageDir, "dist"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  NodeFS.mkdirSync(outDir, { recursive: true });
  const tarball = NodePath.join(outDir, `${source.name}-${version}.tgz`);
  NodeFS.rmSync(tarball, { force: true });
  NodeChildProcess.execFileSync("tar", ["-czf", tarball, "-C", stageRoot, "package"], {
    stdio: "inherit",
  });
  console.log(tarball);
} finally {
  NodeFS.rmSync(stageRoot, { recursive: true, force: true });
}
