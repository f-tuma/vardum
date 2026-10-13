# Upload from a project

Send files from a repository back to the library. All of it needs a **write**
key.

| Command | Does |
| --- | --- |
| `vardum push` | Uploads changes to files behind **Writable** mappings |
| `vardum push-folder <dir> [prefix]` | Uploads a folder to the library, keeping relative paths |
| `vardum push-folder ... --output <path>` | Also adds the files to the Vard (since CLI 0.7.0) |

- Pinned, transformed and folder-rule files are read-only: `push` skips them.
- Every command takes `--dry-run`.

## Push a folder

```sh
vardum push-folder ./images brand/        # into the library under brand/
vardum push-folder ./images               # pick a folder, review, confirm
```

- In a terminal without a prefix, you get a folder picker, the plan and a
  confirmation. With `--json` or no terminal, an omitted prefix selects root.
- Processing is awaited once at the end, with a `(3/50)` counter while it runs.
- `--delete` removes library assets an earlier push created and that are gone
  locally. In a terminal it lists them and asks first.

## Complete plan (CLI 0.8.0)

Use published **CLI 0.8.2** for the complete folder plan introduced in 0.8.0. See
[release evidence and upgrade order](../client-release-0.8.2.md) and
[release status](../npm-release.md).

- Every source file is classified as **New**, **Update** or **Skip**, including
  when the push has no changes. Terminal confirmation shows totals and the first
  15 rows; JSON contains the complete per-file plan. Library-only JSON adds
  `library` beside `actions`.
- Rows report `source`, exact `key`, `libraryAction` and `applied`, with actual
  existing asset/current ready version IDs when available. Pending rows retain
  exact journal IDs, phase and original classification with `resumed: true`.
- A skipped library-only row creates no upload or mutation action, adds no change
  and keeps `applied: false`. New dry-run rows do not reserve upload IDs.
- Confirmation uses the same captured checksum plan. Source metadata, journal,
  remote identity/current version and stem/filename alternatives are checked
  again before upload; imports also recheck mappings. A change requires a new plan.

## Import into the Vard

```text
./images/icons/logo.png
  │  push-folder ./images brand
  │    --output assets/brand/
  │
  ├──> library  brand/icons/logo
  └──> Vard     assets/brand/icons/logo.png
```

- Preview first: the plan lists library `new`/`update`/`skip` and mapping
  `add`/`keep` separately.
- Existing mappings keep their pins, variants and settings.
- The whole plan is checked before anything uploads: unsafe paths, collisions
  and more than 1,000 files fail.
- It does not touch your local files or the lock. Afterwards:

```sh
vardum pull           # then review and commit
```

- `--output` cannot be combined with `--delete` or `--force`.

## If it stops halfway

- Run the **same command** again. It resumes without duplicate versions or
  mappings.
- Progress lives in `.vardum.push.pending.json`. Keep it until the push
  completes. It holds no keys or signed URLs.
- Add these to `.gitignore`:

```text
.vardum.push.pending.json
.vardum.push.mutex
.vardum.push.pending.json.*.tmp
.vardum.push.lock.*.tmp
```

- A killed process can leave `.vardum.push.mutex` behind. Check that no push is
  running, delete only that file, rerun.

## Requirements

- Resumable library mutations require `folderUploadResume: 1`. Imports also
  require `folderVardImport: 1`, including dry-runs. The CLI checks
  `GET /api/capabilities` and refuses unsupported operations.
- CLI 0.6.0 has `push` and `push-folder` without resume or `--output`.

Full reference: [CLI README](../../apps/cli/README.md) and
[folder import](../folder-import.md).
