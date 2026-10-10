# Operations

Backup, restore, upgrades and monitoring for a Compose install. Each section
links to the full runbook for exact commands and edge cases.

```sh
compose() { docker compose --env-file .env.production -f compose.production.yml "$@"; }
```

## Backup

```text
block other bucket writers
  ▼
backup.mjs create   stops the app
  ▼
backup.mjs verify   checks every byte
  ▼
start the app again
```

```sh
node scripts/backup.mjs create --project vardum --env-file .env.production --directory "$dir"
node scripts/backup.mjs verify --project vardum --env-file .env.production --directory "$dir"
compose -p vardum up -d --wait api worker gateway
```

- One bundle: database dump + every object + checksummed manifest.
- Block other bucket writers first; a changing bucket fails the backup.
- Store the bundle **and** an encrypted copy of `.env.production` off the host.
  `TRANSFORM_SECRET` must survive, or signed and locked URLs break.
- The tool does not encrypt, schedule or rotate backups.

[Full runbook](../operations.md#backup)

## Restore

- Into a **new** Compose project, an empty database and an empty bucket.
- Run it in a fresh shell, with `.env.restore` naming the new stores.
- Do not run the migrator first; restore runs it at the end.
- Check logins, private delivery, an old signed URL and a frozen pull before
  sending users there.

[Full runbook](../operations.md#restore)

## Upgrade

1. Read `CHANGELOG.md`, make a backup.
2. Check out the release tag. Keep `.env.production`.
3. `compose up -d --build --wait`; the migrator runs first.
4. `curl --fail "$APP_URL/ready"`.

- Migrations are forward-only. Rolling back across one means restoring the
  backup.
- Some upgrades need services stopped before migrating; the runbook lists them.

[Full runbook](../operations.md#upgrade)

## Health and monitoring

| Probe | Access | Says |
| --- | --- | --- |
| `/health` | Public | API process responds |
| `/ready` | Public | API can reach PostgreSQL |
| `/api/operations/health` | `MONITORING_TOKEN` | DB, queue, bucket, live workers |
| `/api/operations/metrics` | `MONITORING_TOKEN` | Prometheus gauges |

- Set `MONITORING_TOKEN` (32+ chars) to enable the last two.
- Alert rules ship in `docker/monitoring/alerts.yml`.
- A healthy `/ready` does not mean uploads are processed: watch the workers.

[Full runbook](../operations.md#worker-and-queue-monitoring)

## Limits

| Setting | Default | Limits |
| --- | --- | --- |
| `WORKSPACE_STORAGE_MB` | 10240 | Original bytes per workspace |
| `WORKSPACE_PENDING_UPLOADS` | 100 | Unfinished uploads per workspace |
| `UPLOAD_PENDING_HOURS` | 24 | Time to finish an upload |
| `TRANSFORM_CONCURRENCY` | 2 | Uncached variants rendered at once |
| `DELIVERY_REQUESTS_PER_SECOND` | 100 | Delivery per API process |

- Over quota: `413`. Too many unfinished or too fast: `429`. Busy: `503`.
- Variants in `derived/` are not counted; give them a lifecycle rule, never
  `originals/`.

[Full runbook](../operations.md#resource-budgets-and-unfinished-uploads)

## When an upload is stuck

- Failed processing: fix storage, then **Retry processing** in the asset's
  version history.
- Invalid files are not retryable: upload a corrected one.
- Unfinished uploads expire after `UPLOAD_PENDING_HOURS`.

[Full runbook](../operations.md#interrupted-upload-processing)
