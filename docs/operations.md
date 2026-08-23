# Operations

These commands assume the production Compose stack and `.env.production` from
the repository root. Keep that environment file outside public backups: it
contains the secrets needed to keep sessions and signed delivery URLs valid.

Load the deployment values and set the Compose shortcut once per shell:

```sh
set -a
. ./.env.production
set +a
compose() {
  docker compose --env-file .env.production -f compose.production.yml "$@"
}
# Running the bundled object store? Add --profile minio to that command line.
```

## Backup

Stop API writes, then export PostgreSQL and mirror the bucket. PostgreSQL stays
available to the backup commands.

The `mc` commands below address the bundled MinIO from `--profile minio`. With
an external bucket, replace them with your provider's own mirroring — the
important part is that a database dump without the objects is not a backup.

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "backups/$stamp"
compose stop api worker
compose exec -T postgres pg_dump -U varda -d varda -Fc \
  > "backups/$stamp/postgres.dump"
compose --profile minio run --rm --no-deps -v "$PWD/backups/$stamp:/backup" \
  --entrypoint /bin/sh minio-init -ec \
  'mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" &&
  mc mirror "local/$S3_BUCKET" /backup/objects'
compose up -d --wait
```

Also store an encrypted copy of `.env.production`. A backup without the object
bucket is incomplete; the database stores metadata, not image contents.

## Restore

Restore into an empty stack or accept that `pg_restore --clean` replaces the
current database objects. Keep API and worker stopped until both stores match.

```sh
backup=backups/20260822T120000Z
compose --profile minio up -d postgres minio minio-init
compose stop api worker
compose exec -T postgres pg_restore --clean --if-exists -U varda -d varda \
  < "$backup/postgres.dump"
compose --profile minio run --rm --no-deps -v "$PWD/$backup:/backup:ro" \
  --entrypoint /bin/sh minio-init -ec \
  'mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" &&
  mc mirror --overwrite /backup/objects "local/$S3_BUCKET"'
compose up -d --build --wait
curl --fail "$APP_URL/ready"
```

## Upgrade

1. Read `CHANGELOG.md` and create a backup.
2. Check out the desired release tag.
3. Keep the existing `.env.production` secrets.
4. Rebuild and start; the one-shot migrate service applies pending migrations.

```sh
git fetch --tags
git checkout v0.1.0
compose up -d --build --wait
curl --fail "$APP_URL/ready"
```

Database migrations are forward-only. To roll back across a migration, check
out the previous release and restore the backup made before upgrading.
