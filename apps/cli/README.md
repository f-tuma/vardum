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

Private Vards and all write operations need a workspace key. Authorize the
machine once and the CLI keeps it:

```sh
vardum login
```

That opens the browser, asks which workspace and whether the key may push, and
stores it in `$XDG_CONFIG_HOME/vardum/credentials.json` with mode `0600`. The
key carries your own permissions and nothing more, and appears in Settings //
API keys as `cli@<machine>`. `vardum logout` revokes it on the server and
removes it locally.

For CI, keep passing the key explicitly — it overrides anything stored:

```sh
VARDUM_API_KEY=varda_... vardum pull
```

## Commands

```text
vardum init [--server URL --workspace ID --vard ID] [--force]
vardum status [--delete]
vardum sync [--dry-run] [--delete] [--force]
vardum pull [--dry-run] [--delete] [--force]
vardum push [--dry-run] [--force]
vardum pull-asset <asset-key> <output-path> [--dry-run] [--force]
vardum push-folder <directory> [prefix] [--dry-run] [--delete]
```

`status` is `pull` that writes nothing, for asking what a sync would do.
Every command accepts `--json`, which replaces the human output with a single
`{ dryRun, changed, actions }` object and reports failures on stderr as
`{ "error": ... }`, so CI can read the result instead of parsing sentences.

`sync` is an alias for `pull`. Pull and mapped push use `.vardum.lock` to detect
local/remote conflicts. Commit that lockfile when reproducible asset versions
matter. `--delete` removes only outputs or remote assets recorded by an earlier
CLI run; unrelated project files and manually managed workspace assets are not
touched.

Only Vard items marked **Writable** in the UI can be updated by `vardum push`.
Pinned or transformed outputs are always read-only. `push-folder` accepts AVIF,
JPEG, PNG, SVG and WebP files and preserves their relative paths below the
provided workspace prefix.
