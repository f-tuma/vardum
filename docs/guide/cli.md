# CLI

`@vardum/cli` puts a Vard's files into a project and keeps them locked.

```sh
npm install --save-dev --save-exact @vardum/cli@0.6.0
```

Node.js 22 or newer. Pin the exact version in CI.

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
| `--output <path>` | push-folder | Also map files into the Vard (0.7.0) |

## Files

| File | Holds |
| --- | --- |
| `vardum.json` | Server, workspace, Vard |
| `.vardum.lock` | Versions, URLs, SHA-256 per file |
| `.vardum.push.lock` | What `push-folder` uploaded; `--delete` relies on it |
| `.vardum.push.pending.json` | Resume journal (0.7.0) |

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

Full reference: [CLI README](../../apps/cli/README.md).
