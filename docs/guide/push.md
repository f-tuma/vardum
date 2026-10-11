# Upload from a project

Send files from a repository back to the library. All of it needs a **write**
key.

| Command | Does |
| --- | --- |
| `vardum push` | Uploads changes to files behind **Writable** mappings |
| `vardum push-folder <dir> [prefix]` | Uploads a folder to the library, keeping relative paths |
| `vardum push-folder ... --output <path>` | Also adds the files to the Vard (CLI 0.7.0) |

- Pinned, transformed and folder-rule files are read-only: `push` skips them.
- Every command takes `--dry-run`.

## Push a folder

```sh
vardum push-folder ./images brand/        # into the library under brand/
vardum push-folder ./images               # pick a folder, review, confirm
```

- Without a prefix you get a folder picker, the plan, and a confirmation.
- Processing is awaited once at the end, with a `(3/50)` counter while it runs.
- `--delete` removes library assets an earlier push created and that are gone
  locally. In a terminal it lists them and asks first.

## Import into the Vard (CLI 0.7.0)

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

## If it stops halfway (CLI 0.7.0)

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

- Resume and import need a server that supports them; the CLI checks
  `GET /api/capabilities` and refuses otherwise.
- CLI 0.6.0 has `push` and `push-folder` without resume or `--output`.

Full reference: [CLI README](../../apps/cli/README.md) and
[folder import](../folder-import.md).
