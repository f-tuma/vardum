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
vardum whoami
vardum version
vardum status [--delete]
vardum sync [--dry-run] [--delete] [--force]
vardum pull [--dry-run] [--delete] [--force]
vardum push [--dry-run] [--force]
vardum pull-asset <asset-key> <output-path> [--dry-run] [--force]
vardum push-folder <directory> [prefix] [--dry-run] [--delete]
```

`status` is `pull` that writes nothing, for asking what a sync would do — it
reports locally edited files as conflicts rather than refusing to run.
`whoami` prints which project, workspace and key are in play without touching
the network, which is usually the answer to "why does this not work".
Every command accepts `--json`, which replaces the human output with a single
`{ dryRun, changed, actions }` object and reports failures on stderr as
`{ "error": ..., "actions": [...] }` — a run that dies halfway still says which
changes landed, each with `applied: true|false`, so CI can read the result
instead of parsing sentences.

`sync` is an alias for `pull`. Pull and mapped push use `.vardum.lock` to detect
local/remote conflicts. Commit that lockfile when reproducible asset versions
matter. `--delete` removes only outputs or remote assets recorded by an earlier
CLI run; unrelated project files and manually managed workspace assets are not
touched. In a terminal, `push-folder --delete` lists the remote assets it would
delete and asks first; with `--force`, `--json`, or no TTY it proceeds
unattended, so CI is unchanged.

Only Vard items marked **Writable** in the UI can be updated by `vardum push`.
Pinned or transformed outputs are always read-only. `push-folder` accepts every format the
workspace accepts (images and video, see `@vardum/shared`) and preserves
relative paths below the chosen workspace prefix. Without a prefix argument it
opens a picker with the workspace's folders, shows the file-by-file plan, and
waits for confirmation; uploads then run with a `(3/50)` counter and processing
is awaited once at the end rather than per file.
