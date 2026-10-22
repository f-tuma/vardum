# Use assets in a project

Pull files into a repository, review changes like code, restore them exactly
in CI.

## The loop

```text
designer uploads v8
        │
        ▼
vardum status    what would change
vardum pull      files + lock updated
git commit       review like code
        │
        ▼
CI: vardum pull --frozen
    same bytes, checksums verified
```

## Setup

```sh
npm install --save-dev --save-exact @vardum/cli@0.8.3
npx vardum init       # vardum.json: server, workspace, Vard
npx vardum login      # stores a key for this machine
```

- `login` keeps the key in `$XDG_CONFIG_HOME/vardum/credentials.json` (mode
  `0600`), named `cli@<machine>` in Settings. `logout` revokes it.
- `VARDUM_API_KEY` overrides the stored key. Use it in CI.

The setup above uses published **CLI 0.8.3**. It retains schema 2 and needs no
snapshot migration. See [release status](../npm-release.md) before changing the
pinned package. The first-project/server compatibility fixture remains on CLI 0.6.0.

## Pull

- Adopts everything new in the Vard: versions, files, paths, variants.
- Writes `.vardum.lock`. Commit it with `vardum.json`.
- Refuses to overwrite files you edited locally; `--force` overwrites.
- `--dry-run` shows the plan. `--json` prints it for scripts.

## Existing project files

When the project already contains every mapped output, preview adoption first:

```sh
npx --no-install vardum status --adopt-existing --json
npx --no-install vardum pull --adopt-existing --json
```

Run the second command only when every decision is `adopt`. The CLI compares
each file with the actual immutable downloaded output, including transformations
and pinned versions, then records one complete schema 2 `.vardum.lock`. It does
not replace any asset file. Commit the lock with `vardum.json`.

Missing or outdated files are `download` decisions; different or locally edited
files are `conflict` decisions. Either blocks adoption. Resolve them deliberately
before retrying; ordinary pull keeps its existing overwrite protections.
Status and dry-run retain no project or update-cache writes. Adoption cannot
combine with `--frozen`, `--force`, `--delete`, context overrides or positional
arguments. See [the release contract](../client-release-0.8.2.md#existing-project-files)
for drift checks and the limits of coordination with other writers.

## Frozen pull

```sh
npx --no-install vardum pull --frozen --json
```

| Does | Does not |
| --- | --- |
| Restore missing files from the lock | Read the live Vard |
| Verify each download's SHA-256 | Rewrite the lock |
| Skip files that already match | Fall back to latest |
| Refuse local edits (unless `--force`) | Delete files (`--delete` is rejected) |

It keeps working only while the locked versions exist and the server URL,
workspace slug and `TRANSFORM_SECRET` stay the same.

## Removing files

- `--delete` removes only files an earlier CLI run wrote.
- Use it **on the pull that drops them** from the Vard. A pull without it keeps
  the files on disk but forgets them, and a later `--delete` cannot find them.
- Preview with `vardum status --delete`.

## Folder rules

- `brand/` to `assets/brand/` includes every ready file below `brand/`.
- Generated files are read-only and follow latest.
- Limits: 64 rules, 1,000 files per Vard. Colliding paths fail; nothing is
  silently dropped.

## Requirements

- Frozen pulls need CLI **0.6.0** or newer.
- Private files need a key with read access, also in CI.

Full reference: [CLI README](../../apps/cli/README.md#reproducible-asset-consumption).
