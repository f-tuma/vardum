# Concepts

The whole model on one screen.

```text
organization
└── workspace
    ├── assets ── v1  v2  v3 ◄ current
    └── Vards ─── mappings, folder rules
                    │
                    │ vardum pull
                    ▼
         vardum.json + .vardum.lock
```

## Assets and versions

- An asset is one file, keyed like a path: `brand/logo`.
- Every upload adds a version. Nothing is overwritten.
- A version becomes current once the worker has checked it.
- Restoring moves the current pointer back. It is audited.
- Images and video. Video has no variants.

## Visibility

- New assets are **private**: every request needs workspace read access.
- Public assets: anyone with the URL.
- A public Vard does **not** publish its files.

## Vards

A Vard lists what one project needs.

| Item | What it does |
| --- | --- |
| Mapping | One asset to one path, e.g. `public/logo.svg` |
| Pin | Keeps a mapping on one version instead of latest |
| Variant | Resized or converted copy: size, fit, format, quality |
| Folder rule | `brand/` to `assets/brand/`: every ready file below |
| Writable | Lets `vardum push` update the asset |

## Project files

| File | Holds | Commit |
| --- | --- | --- |
| `vardum.json` | Server, workspace ID, Vard ID | Yes |
| `.vardum.lock` | Path, version, URL and SHA-256 of every file | Yes |

## Pull and frozen pull

```text
vardum pull
  live Vard ──> files + new lock    review

vardum pull --frozen
  lock ───────> same files, verified    CI
```

- Nothing changes in a repository until someone pulls.

## People and keys

- Roles: **owner**, **editor**, **viewer**, per organization.
- Owners create workspaces.
- API keys belong to one workspace: **read**, or **write** (create, update,
  delete, publish).
