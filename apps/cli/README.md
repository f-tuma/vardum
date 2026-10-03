# Vardum CLI

The CLI materializes a workspace **Vard** into a project. Create a Vard in the
web UI, select its assets and output paths, then run `vardum init` in the target
repository to create `vardum.json`.

## First project

For a runnable three-file example, follow [First project](../../examples/first-project/README.md).

Use Node.js 22 or newer. These commands target published CLI **0.6.0** and the
matching server API contract; see [release status and compatibility](https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md).
Published CLI 0.5.0 has a broken workspace dependency and does not support frozen
snapshots.

1. In the web app, upload an image, create a Vard and add an output such as
   `public/logo.svg`. Keep its CLI config tab open for the server URL, workspace
   ID and Vard ID. **Copy setup** combines the following steps into one command
   with all three values filled in (bash/zsh).
2. In your project root, install an exact CLI version, initialize the project
   and authorize your machine:

   ```sh
   npm install --save-dev --save-exact @vardum/cli@0.6.0
   npx vardum init
   npx vardum login
   npx vardum pull
   ```

   `init` asks for the three values from the CLI config tab and creates
   `vardum.json`. Copying that JSON into the project manually also works.

3. Review the downloaded files. Commit `vardum.json`, `.vardum.lock`,
   `package.json` and your npm lockfile. In CI use the installed CLI:

   ```sh
   npm ci
   npx --no-install vardum pull --frozen --json
   ```

   Supply a workspace read key through the CI secret `VARDUM_API_KEY`.
   A normal `pull` intentionally adopts remote changes; frozen pull restores
   the reviewed snapshot. `vardum push` only updates mappings marked Writable.

For a source checkout, run
`pnpm --filter "@vardum/cli..." build` and use `node /absolute/path/to/vardum/apps/cli/dist/index.js`
in place of `npx vardum` from the target project.

Private files, private Vards and all write operations need a workspace key.
Authorize the machine once and the CLI keeps it:

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
VARDUM_API_KEY=varda_... vardum pull --frozen --json
```

## Commands

```text
vardum init [--server URL --workspace ID --vard ID] [--dry-run] [--force]
vardum whoami
vardum version
vardum update [--json]
vardum status [--frozen | --delete]
vardum sync [--frozen | --delete] [--dry-run] [--force]
vardum pull [--frozen | --delete] [--dry-run] [--force]
vardum push [--dry-run] [--force]
vardum pull-asset <asset-key> <output-path> [--dry-run] [--force]
vardum push-folder <directory> [prefix] [--dry-run] [--delete]
```

`init` safely reuses an existing configuration for the same Vard. A different
or invalid configuration requires `--force`; `--dry-run` never writes it.
Without an interactive terminal (including `--json`), supply all three flags.
Project-based `login` preselects the workspace from `vardum.json` in the browser.

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
local/remote conflicts. `--delete` removes only outputs or remote assets recorded
by an earlier CLI run; unrelated project files and manually managed workspace
assets are not touched. In a terminal, `push-folder --delete` lists the remote
assets it would delete and asks first; with `--force`, `--json`, or no TTY it proceeds
unattended, so CI is unchanged.

Only Vard items marked **Writable** in the UI can be updated by `vardum push`.
Pinned, transformed and folder-generated outputs are always read-only. `push-folder` accepts every
format the workspace accepts (images and video, see `@vardum/shared`) and preserves
relative paths below the chosen workspace prefix. Without a prefix argument it
opens a picker with the workspace's folders, shows the file-by-file plan, and
waits for confirmation; uploads then run with a `(3/50)` counter and processing
is awaited once at the end rather than per file.

## Folder membership updates

Configure literal recursive rules in the Vard editor or through MCP:
`brand/` → `assets/brand/` maps `brand/icons/logo.svg` to
`assets/brand/icons/logo.svg`. Generated files use ready current originals only,
are read-only, and preserve the relative suffix. Pending files are excluded until
ready. An empty source prefix selects workspace root; an empty output prefix
selects project root. Empty/nonexistent folders are valid. There are no globs,
excludes or rule transformations. Manual pins, transforms and writable mappings
remain separate.

The API permits 64 rules with prefixes up to 255 characters, and at most 1,000
combined manual + generated outputs with paths up to 500 characters. Collisions
between explicit mappings and rules (or between rules), including case/Unicode
and file/directory overlaps, fail rather than choose precedence or truncate.
Repair configuration in the editor even if its live preview cannot resolve.
Adding a private member blocks the entire anonymous public manifest, not just
that member; use an authorized workspace read key.

There is no background project sync. Normal `vardum pull` resolves new ready
members, removed members and changed current versions; `--frozen` does not fetch
or expand the live rules and keeps the committed membership. Rule removal leaves
manual mappings and source assets intact. **Choose `vardum pull --delete` on the
membership-updating pull** if stale tracked files should be removed. A normal
pull without `--delete` retains stale disk files but drops their snapshot entries;
a later `--delete` cannot discover them. Leftovers then require deliberate manual
cleanup. Review `vardum status --delete` before that updating pull if needed.

## Reproducible asset consumption

**Minimum compatible CLI: 0.6.0**, with the matching server from the
[compatibility table](https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md#compatibility).
Pin the exact tested version in CI. Older clients, including published 0.5.0,
cannot safely maintain schema 2 snapshots. CLI 0.6.0 is published; a source
version bump or passing candidate checks does not publish its successor.

1. Run **`vardum pull`** to intentionally resolve the current Vard and refresh
   its files and snapshot. Use `--delete` explicitly if obsolete tracked outputs
   should be removed. Review and commit `vardum.json` and `.vardum.lock` together.
2. In CI or on an old checkout, run **`vardum pull --frozen --json`** with
   `VARDUM_API_KEY` supplied by the CI secret store when needed. `sync --frozen`
   is identical. Never use normal pull as the reproducible build step.
3. To adopt new remote versions, membership, paths or transformations, run normal
   pull again and review the changed snapshot. **`vardum update` updates the CLI
   executable, not asset dependencies.**

Schema 2 binds the normalized server URL, workspace and Vard IDs. Its `items`
map records exact membership, repository-relative output paths, version IDs,
fingerprints, fully resolved immutable download URLs (including signed
transformation queries), and SHA-256 hashes of downloaded bytes. The snapshot
is not a cache or an archive. Treat it as trusted, reviewable project input:
checksums detect changed delivery bytes, not a malicious commit that changes
both the URL and checksum. Signed URLs may be sensitive; review repository
visibility before committing them. API keys are never stored in the snapshot.

Frozen pull does not fetch the current Vard manifest and never rewrites the
lock. It restores missing files from locked URLs even when the current Vard has
changed or no longer includes them. Existing files matching the locked checksum
need no download. Local edits cause refusal unless `--force` is given;
`--force` never bypasses downloaded checksum verification. Each download is
verified before an atomic file replacement. A later failure can leave earlier
files restored: errors include actions with `applied` flags and exit nonzero.
There is no silent fallback to latest.

`status --frozen` and `pull --frozen --dry-run` only inspect local files and
report planned changes and conflicts (`conflict: true` in JSON); they do not
check remote availability. `--frozen --delete` is rejected: a snapshot cannot
infer unrelated or newly stale files, and frozen pull leaves all files outside
its membership alone. Frozen context overrides and positional arguments are
also rejected; the checked-in configuration is authoritative.

A missing or schema 1 lock is not a frozen snapshot. Run normal `vardum pull`
to create/upgrade it, then review and commit. Malformed, unsupported or
context-mismatched locks fail closed even on normal pull; restore a valid lock
from version control before refreshing (do not discard conflict history
blindly). Mapped push keeps schema 2 URLs, versions and verified checksums in
step; legacy mapped push retains schema 1 until a normal pull upgrades it.

Reproduction requires the locked versions to remain stored and reachable.
Deleting assets/versions, renaming a source key, changing the server URL or workspace slug, rotating
transformation signing keys, expired signatures, or changes to transformation
rendering can make an old snapshot unavailable or fail its checksum. Frozen
pull reports that failure rather than refreshing signatures or changing bytes.
All downloads must stay on the configured server origin, and redirects are
refused to prevent API-key forwarding. There is no offline cache or new
retention guarantee. **Source-key rename can invalidate historical URLs despite
retained bytes.** Frozen restore after rule/membership removal with valid source
URLs does not prove frozen rename support. Private locked originals and variants require a workspace
key with `read` permission, even without a live manifest; use `VARDUM_API_KEY`
in CI. Visibility changes leave locked version URLs and checksums unchanged.
Existing matching local files need no network access and cannot be revoked.
Previously public shared/browser caches can also outlive a visibility change.

New assets created by CLI upload or bucket import are private. A public Vard
never publishes them: if any mapped asset is private, anonymous manifest access
fails for the entire package. Use a read key or explicitly change each asset's
visibility in the app or through MCP `set_asset_visibility` (publication requires
`publish` permission).
New workspace API/CLI keys have a finite 10,000-request/60-second allowance;
private file requests now consume it. Existing custom key limits still apply.
This allowance is not a throughput guarantee; see the
[upgrade notes](https://github.com/f-tuma/vardum/blob/main/docs/operations.md#asset-visibility-upgrade) for legacy keys.
