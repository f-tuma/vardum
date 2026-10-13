# CLI

`@vardum/cli` puts a Vard's files into a project and keeps them locked.

```sh
npm install --save-dev --save-exact @vardum/cli@0.8.2
```

Node.js 22 or newer. This installs published **0.8.2**; pin the exact version
in CI. It includes the [complete folder plan](push.md#complete-plan-cli-080).
See [release status](../npm-release.md) for compatibility and evidence.

## Commands

| Command | Does |
| --- | --- |
| `init` | Writes `vardum.json` (asks for server, workspace, Vard) |
| `login` / `logout` | Stores / revokes a key for this machine |
| `whoami` | Shows project, workspace and key; no network |
| `status` | What `pull` would change; writes nothing |
| `pull` | Downloads changes, updates `.vardum.lock` |
| `pull --frozen` | Restores exactly what the lock says |
| `push` | Uploads changes behind Writable mappings |
| `push-folder <dir> [prefix]` | Uploads a folder to the library |
| `pull-asset <key> <path>` | Downloads one asset |
| `version` / `update` | Prints / updates the CLI itself, not assets |

`sync` is an alias for `pull`.

## Flags

| Flag | On | Effect |
| --- | --- | --- |
| `--dry-run` | most | Plan only, write nothing |
| `--json` | except help/version | One JSON result on stdout, errors on stderr |
| `--force` | pull, push | Overwrite local edits / conflicts |
| `--delete` | pull, push-folder | Remove files an earlier run created |
| `--frozen` | pull, status | Use the lock, not the live Vard |
| `--adopt-existing` | pull, status | Verify every output; `pull` records only the lock; [all outputs must match](pull.md#existing-project-files) |
| `--output <path>` | push-folder | Also map files into the Vard (since 0.7.0) |

`--adopt-existing` cannot combine with `--frozen`, `--force`, `--delete`,
context overrides or positional arguments. Preview with `status` before applying.

## Files

| File | Holds |
| --- | --- |
| `vardum.json` | Server, workspace, Vard |
| `.vardum.lock` | Versions, URLs, SHA-256 per file |
| `.vardum.push.lock` | What `push-folder` uploaded; `--delete` relies on it |
| `.vardum.push.pending.json` | Resume journal (since 0.7.0) |

- Commit `vardum.json` and `.vardum.lock`.
- Keep the resume journal out of git.

## Keys

- `vardum login` stores a key in `$XDG_CONFIG_HOME/vardum/credentials.json`.
- `VARDUM_API_KEY` overrides it. Use a read key in CI.
- Writes need a write key.

## JSON output

```json
{ "dryRun": false, "changed": 2, "actions": [ { "applied": true, "...": "..." } ] }
```

- A failure still lists what already happened, each action with `applied`.
- CLI 0.8.0 adds every library-only folder source to `library`, with
  `new`/`update`/`skip`, its exact key and known IDs. A skipped library-only row
  keeps `applied: false`, creates no mutation action and adds no change. Pending
  uploads retain journal IDs and original classification with `resumed: true`.
- A failed/lost response can follow a remote mutation even when `applied` is
  false; preserve the pending journal and rerun the same folder command.

Full reference: [CLI README](../../apps/cli/README.md).
