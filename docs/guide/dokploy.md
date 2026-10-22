# Deploy with Dokploy

The same stack on Dokploy, where Traefik already handles TLS.

| File | Use |
| --- | --- |
| `compose.dokploy.yml` | Production; app at `/app/`, optional marketing at `/` |
| `compose.dokploy.dev.yml` | Branch deployment; separate secrets and bucket |

- Use **Docker Compose** mode with a Git source, not Docker Stack.
- Keep the Compose project name stable: it names containers, volumes and images.

## Install

1. Paste `.env.dokploy.example` into the Environment editor. Replace every
   domain, email, password and bucket credential.
2. `APP_URL`: the HTTPS origin, without `/app`; the app opens at `/app/`.
3. Secrets: `openssl rand -hex 32` each; two different database passwords.
4. **Domains**: app hostname → service `gateway`, port `80`, path `/`, HTTPS.
5. Disable **Isolated Deployments** (the gateway joins `dokploy-network`).
6. Check **Preview Compose**, then deploy.

```text
internet
  └─ Traefik  TLS
       └─ gateway :80
            ├─ api
            ├─ worker     no public
            └─ postgres   ports
```

## Storage

| Option | Set |
| --- | --- |
| External bucket | `S3_ENDPOINT` for the API, `S3_PUBLIC_ENDPOINT` for browsers (HTTPS) |
| Amazon S3 | Both endpoints blank, the region set, `S3_FORCE_PATH_STYLE=false` |
| Bundled RustFS | `COMPOSE_PROFILES=rustfs`, `S3_ENDPOINT=http://rustfs:9000`, a Domain on `rustfs:9000` |

- Bundled RustFS: start storage and create the bucket before the app; see the
  [full guide](../dokploy.md#choose-storage) for the commands.
- Keep the RustFS console (9001) private and the bucket private.

## Check it works

- Migration logs succeed, the worker is healthy, `/ready` answers.
- Then by hand: sign-up email, upload, private and public delivery, a Vard,
  `vardum login`, `pull` and `pull --frozen`.

## Upgrade

1. Back up database, objects and secrets, off the host.
2. Stop gateway, API and worker.
3. Deploy the new commit; the migration must succeed.
4. Start the services again.

- No unattended AutoDeploy for upgrades with migrations.
- Never `down -v`: it deletes the volumes.
- Migrations are forward-only; rollback means restoring the backup.

## Optional marketing site

- Attach it to `dokploy-network` and set `MARKETING_UPSTREAM=<alias>:80`.
  The current website source uses `vardum-marketing:80`; verify the live alias
  and healthy image before using it.
- Give it no Domain of its own for the app hostname; keep gateway's path `/`
  and do not strip `/app`.
- Without marketing, `/` redirects to `/app/`. App assets stay under `/app/`;
  API and delivery URLs stay at the origin, without `/app`.
- Old root UI links, including `/cli-login?...`, redirect with their query
  intact. The gateway healthcheck uses `/app/` independently of marketing.
- A code rollback needs a compatible gateway/API pair for new `/app/...` links;
  restoring only the previous marketing setting keeps the new app base.

Full guide: [docs/dokploy.md](../dokploy.md).
