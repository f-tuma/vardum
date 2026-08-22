# Vardum CLI

The CLI materializes a workspace **Vard** into a project. Create a Vard in the
web UI, select its assets and output paths, then copy the generated
`vardum.json` into the target repository.

Build and link the workspace package once during development:

```sh
pnpm --filter @vardum/cli build
pnpm --filter @vardum/cli link --global
```

Then run it from the repository containing `vardum.json`:

```sh
vardum pull
vardum push
```

Private Vards and all write operations use a workspace API key:

```sh
VARDUM_API_KEY=vardum_... vardum pull
```

## Commands

```text
vardum init [--server URL --workspace ID --vard ID] [--force]
vardum sync [--dry-run] [--delete] [--force]
vardum pull [--dry-run] [--delete] [--force]
vardum push [--dry-run] [--force]
vardum pull-asset <asset-key> <output-path> [--dry-run] [--force]
vardum push-folder <directory> [prefix] [--dry-run] [--delete]
```

`sync` is an alias for `pull`. Pull and mapped push use `.vardum.lock` to detect
local/remote conflicts. Commit that lockfile when reproducible asset versions
matter. `--delete` removes only outputs or remote assets recorded by an earlier
CLI run; unrelated project files and manually managed workspace assets are not
touched.

Only Vard items marked **Writable** in the UI can be updated by `vardum push`.
Pinned or transformed outputs are always read-only. `push-folder` accepts AVIF,
JPEG, PNG, SVG and WebP files and preserves their relative paths below the
provided workspace prefix.
