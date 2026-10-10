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

In the source checkout, folder upload actions also include `phase`, `assetId`
and `versionId` once an upload intent is recorded. `applied: true` means that
the exact version is ready and its checksum and metadata have been verified.
An action with `applied: false` may have created an asset, reserved a version,
uploaded bytes or started processing; its phase identifies the last known step.
Journal files are fsynced before requests and replaced atomically; directory
entries are also flushed on systems that support directory fsync.

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

In a source checkout, automatic folder keys and display names strip the final
supported media suffix: `icons/logo.v2.png` becomes key `icons/logo.v2` and name
`logo.v2`. The uploaded version retains `logo.v2.png`. Prefixes with or without
a trailing slash are equivalent. Files such as `logo.png` and `logo.webp` that
would share a key fail before upload. An existing exact filename key from an
older CLI is reused without renaming it; if both that key and its extensionless
counterpart exist, resolve the ambiguity before pushing. Folder rules preserve
existing media suffixes and append the original format's extension to keys
without a media suffix; output collisions are rejected.

In a source checkout, `push` and `push-folder` fetch `/api/upload-limits` before
reading file contents, including during `--dry-run` and for unchanged files.
The command fails if that endpoint is unavailable or returns invalid ceilings,
or if a file is empty, not regular, too large for its MIME type, or changes
while being read. An oversized unchanged file therefore fails rather than
being skipped. Folder push checks the bytes again against its plan before
creating a new asset. These source changes do not patch the immutable published
CLI 0.6.0 package; they require a separate CLI release.

The source checkout supports resumable `push-folder` uploads. This behavior
requires a matching server that advertises `folderUploadResume: 1` through
`GET /api/capabilities`; the CLI refuses mutations on an older server. It is
not included in the published CLI 0.6.0 package, and its next release remains
unpublished until released separately.

Rerun the same folder command after a storage failure, lost response or
processing timeout. The CLI keeps `.vardum.push.pending.json` in the project
root, with stable asset/version IDs, SHA-256 checksums and file metadata saved
before requests. It binds that journal to the server, workspace, canonical
source directory and normalized prefix. Restore changed or missing source
bytes before resuming. The journal contains no API keys or signed storage URLs.
The CLI resumes pending uploads, waits for exact processing versions, and
retries retryable failures without reserving another version. An existing
asset without a ready version can adopt a matching pending upload; original
asset names are preserved. A completed unchanged push creates no new versions.

Keep the pending journal until recovery completes. Ready entries are removed
only after `.vardum.push.lock` has been durably updated. Expired or nonretryable
versions require inspection and explicit resolution on the server; the error
includes their IDs. After resolving them, archive the journal before planning
a new upload. Do not discard it merely because a command failed.

Only one local folder push can own `.vardum.push.mutex` at a time. Normal
errors release it. A killed process can leave the mutex behind: confirm that
no folder push is running, remove only the abandoned mutex, and rerun the same
command while keeping the pending journal. Add the pending journal, mutex and
`.vardum.push.pending.json.*.tmp` / `.vardum.push.lock.*.tmp` files to the target
project's `.gitignore`. `push-folder --dry-run` creates no journal, mutex,
tracking file or version-check cache and performs no remote mutations.

The source checkout also supports an opt-in import into the **configured Vard**:

```sh
vardum push-folder ./source-images brand --output assets/brand/ --dry-run
vardum push-folder ./source-images brand --output assets/brand/
```

Without `--output`, folder push keeps its library-only behavior. With `--output`,
the CLI uploads sources under the workspace prefix and adds missing explicit
Vard mappings. Output paths combine the normalized output prefix with each
original relative source filename: `icons/logo.jpg` becomes
`assets/brand/icons/logo.jpg`, while the asset key is `brand/icons/logo`.
`--output ""` selects project root. Unsafe paths, case/Unicode and file/directory
collisions fail. The import supports 1,000 files and validates the entire plan
before uploading. Existing exact source/path mappings are kept; existing
transforms, pins, writable mappings and conflicting outputs are not replaced.
`--output` cannot be combined with `--delete` or `--force`. Context comes from
`vardum.json`; server, workspace and Vard overrides are not accepted.

This source-only feature requires **both** `folderUploadResume: 1` and
`folderVardImport: 1` from the server, including during `--dry-run`. The server
preflights the actual import permissions and projected collisions with explicit
mappings and folder rules before any upload. A dry-run reports library
`new`/`update`/`skip` and mapping `add`/`keep` separately, with no local journal,
mutex, tracking or version-check-cache writes. It calls a read-only import-plan
endpoint and creates no remote assets, versions or mappings. It is not included
in the published CLI 0.6.0 package; a separate npm release is required.

Vard imports use a schema 2 pending journal that additionally binds the Vard and
output prefix and records every source's stable identity and exact ready version,
including unchanged sources. Mapping failure, lost responses and local tracking
failures preserve ready entries. Rerun the same command to reuse the upload IDs
and finish missing mappings without creating versions for unchanged files.
The server rechecks every exact current ready version at apply time; concurrent
updates cause refusal instead of mapping an older version. A library-only schema
1 journal cannot be retargeted into a Vard, and an unfinished schema 2 import
cannot be resumed in library-only mode or against a different target.

JSON output has separate `library` and `mappings` arrays with phases and
`applied` flags, including completed work when the command later fails.
`applied: false` does not prove that no remote change occurred: a lost response
can follow a successful upload or mapping write. Keep the pending journal and
retry. Imports update `.vardum.push.lock` after mappings complete; they do not
write `.vardum.lock`, run a pull, or overwrite source files. Run a normal
`vardum pull` separately when you intentionally want to refresh delivered assets
and their committed snapshot.

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
