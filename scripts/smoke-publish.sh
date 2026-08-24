#!/usr/bin/env bash
# What gets published must be installable. Inside the repo every workspace
# dependency resolves through a symlink and looks fine, so a private or
# mis-versioned one only shows up once someone runs npm install.
set -euo pipefail

cd "$(dirname "$0")/.."
repo="$PWD"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

pnpm --filter "@vardum/cli..." --filter "@vardum/mcp..." build
for package in packages/shared apps/cli apps/mcp; do
  (cd "$package" && pnpm pack --pack-destination "$staging" >/dev/null)
done

for tarball in "$staging"/*.tgz; do
  tar -xzOf "$tarball" package/package.json > "$staging/manifest.json"
  node --input-type=module -e '
    import { readFileSync, readdirSync, existsSync } from "node:fs";
    const [manifestPath, repo] = process.argv.slice(1);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const projects = new Map();
    for (const group of ["apps", "packages"])
      for (const entry of readdirSync(`${repo}/${group}`)) {
        const path = `${repo}/${group}/${entry}/package.json`;
        if (!existsSync(path)) continue;
        const project = JSON.parse(readFileSync(path, "utf8"));
        projects.set(project.name, project);
      }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (range.startsWith("workspace:"))
        throw new Error(`${manifest.name} publishes ${name} as "${range}"`);
      const project = projects.get(name);
      if (!project) continue;
      if (project.private)
        throw new Error(`${manifest.name} depends on ${name}, which is private`);
      if (!range.includes(project.version))
        throw new Error(
          `${manifest.name} wants ${name}@${range}, workspace has ${project.version}`,
        );
    }
  ' "$staging/manifest.json" "$repo"
done

cd "$staging"
npm init -y >/dev/null
npm install --no-audit --no-fund --no-package-lock ./*.tgz >/dev/null
# Each binary must answer with its own version: that proves the bin entry, the
# built dist and the shared package all resolve from a plain npm install.
check() {
  local binary="$1" flag="$2" expected="$3" actual
  actual="$("./node_modules/.bin/$binary" "$flag")"
  [ "$actual" = "$expected" ] || {
    echo "$binary reported '$actual', expected '$expected'" >&2
    exit 1
  }
}
cli="$(node -p "require('$repo/apps/cli/package.json').version")"
mcp="$(node -p "require('$repo/apps/mcp/package.json').version")"
check vardum version "$cli"
check vardum-mcp --version "$mcp"
echo "Publish smoke test passed (@vardum/cli $cli, @vardum/mcp $mcp install and run)"
