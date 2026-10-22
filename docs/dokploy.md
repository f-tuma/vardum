# Deploy Vardum with Dokploy

Use `compose.dokploy.yml` with **Docker Compose** mode and a Git source. Docker
Stack/Swarm cannot build these images or honor this migration dependency flow.
For a separate development deployment use `compose.dokploy.dev.yml`, different
secrets and a separate bucket. Keep each Dokploy application's Compose project
name stable: it identifies its containers, named volumes and image tags.

## Environment and domain

1. Paste `.env.dokploy.example` into Dokploy's Environment editor. Replace all
   example domains, administrator emails, passwords and bucket credentials.
   `.env.example` is only for local development; it contains local credentials.
2. Set `APP_URL` to the canonical HTTPS origin, such as
   `https://assets.example.com`, without `/app`. The app and API share that
   origin. Generate distinct auth/transform secrets with `openssl rand -hex 32`;
   use different URL-safe database administrator and runtime passwords.
3. For a new `allowlist` installation, set your own
   `ORGANIZATION_CREATOR_EMAILS` and configure a real SMTP sender. Sign up and
   verify that email before creating the first organization. Empty SMTP disables
   verification, invitations and password recovery. See the
   [bootstrap procedure](operations.md#organization-bootstrap-and-email-verification).
4. In Domains, add the app hostname on service **gateway**, container port
   **80**, path `/`, with HTTPS. Point DNS at Dokploy. Keep PostgreSQL, API,
   migration and worker services off the public network. The gateway already
   connects to `dokploy-network` for Traefik; disable **Isolated Deployments**
   for this shared-network template, especially when connecting a separate
   marketing application.
5. Review Dokploy's **Preview Compose** before deploying. A custom delivery
   hostname also needs DNS, a TLS certificate and a Dokploy Domain pointing at
   the same gateway. `CUSTOM_DOMAIN_TARGET` supplies DNS instructions in the UI;
   it does not provision Traefik routes or certificates.

The application lives at `/app/`, including its JavaScript, CSS, fonts and
favicon. Without marketing, the apex redirects there. Standard, development
and Dokploy gateway images use the same app base. API/auth endpoints, `/w/`,
`/v/`, legacy `/assets/` delivery and health endpoints stay at the origin;
`APP_URL`, `WEB_URL`, `BETTER_AUTH_URL` and CLI `server` must have no `/app` suffix.
The Vite development entry is `http://localhost:5173/app/`.

To serve marketing at the apex, attach that deployment to `dokploy-network`
under its unique alias and set `MARKETING_UPSTREAM=<alias>:80`. The current
`vardum-website` source declares service `web`, port `80`, alias
`vardum-marketing`, so its documented setting is
`MARKETING_UPSTREAM=vardum-marketing:80`. Confirm the running deployment actually
has that alias and is healthy before changing the gateway setting. Give the
marketing site no competing Domain for the app hostname. Preview Compose must
keep one hostname on gateway:80, path `/`, without stripping `/app`. The nginx
template is baked into the gateway image; no checkout bind mount is needed.

Marketing receives `/`, its pages, `/docs/`, `/_astro/` and `/favicon.svg` with
the original URI. `/app/` works even while marketing is unavailable, and the
gateway healthcheck checks `/app/`. Old root UI links such as `/account`,
`/workspaces/...`, `/reset-password`, `/accept-invitation` and the published CLI's
`/cli-login?...` temporarily redirect to their `/app/` counterparts while
preserving escaped paths and query parameters. Existing signed delivery URLs
and CLI configuration do not change.

Use a verified healthy marketing image for cutover. A fresh website build
fetches documentation and can fail while its source repository is private;
resolve that build source separately before relying on a fresh default build.
To roll back only marketing, restore the recorded previous `MARKETING_UPSTREAM`;
the loopback fallback opens `/app/`. Keep a compatible gateway/API pair for a
code rollback: an older unprefixed router cannot open new `/app/...` email links
without a separately tested compatibility gateway.

## Choose storage

**External S3-compatible storage:** create a private bucket and a scoped key
before deployment. Set `S3_ENDPOINT` to the API/worker endpoint and
`S3_PUBLIC_ENDPOINT` to the endpoint browsers can reach over HTTPS. The app signs
POST uploads against the public endpoint; a Docker hostname such as `rustfs`
cannot be the public endpoint. Use `S3_FORCE_PATH_STYLE=true` when required by
the provider. The checked-in example illustrates Hetzner; replace its location
and credentials. For Amazon S3, leave both endpoint variables blank, set the
region and use `S3_FORCE_PATH_STYLE=false`; the SDK chooses the bucket's regional
host. `VITE_UPLOAD_ORIGINS` is a build-time development-origin override, not S3
CORS or a production origin allowlist.

The provider must support presigned POST policies, bucket CORS and the object
operations in the [storage compatibility procedure](operations.md#object-storage-compatibility-and-rustfs-upgrade).
The API attempts bucket CORS configuration; verify actual browser uploads rather
than relying on successful startup. Keep objects private: public/private delivery
is controlled by Vardum, not a public bucket policy.

**Bundled RustFS:** enable `COMPOSE_PROFILES=rustfs`, set
`S3_ENDPOINT=http://rustfs:9000`, `S3_PUBLIC_ENDPOINT=https://storage.example.com`,
`S3_REGION=us-east-1` and `S3_FORCE_PATH_STYLE=true`. The supplied keys become
RustFS root credentials. Add a separate HTTPS Domain to service **rustfs**, port
**9000**; keep the console on port 9001 private. Start storage and initialize the
bucket before starting the application. From the checkout/environment used by
Dokploy, with its existing project name. For these manual commands, save the
intended server environment in the ignored `.env.dokploy` file with permissions
`0600`, or substitute the path to Dokploy's generated environment file. Pasting
variables into the UI does not create a file named `.env.dokploy`. Do not use the
unmodified example file or a local development `.env`:

```sh
docker compose -p YOUR_DOKPLOY_PROJECT --env-file .env.dokploy -f compose.dokploy.yml --profile rustfs up -d --wait rustfs
docker compose -p YOUR_DOKPLOY_PROJECT --env-file .env.dokploy -f compose.dokploy.yml --profile rustfs run --rm rustfs-init
```

Do not create a different project merely to run these commands. Do not run
`up --wait` over the init service: its successful exit is a one-shot completion,
not a long-running healthy service. Never expose a volume's contents directly
through Traefik. Existing storage requires the linked backup/upgrade procedure.

## Install, verify and upgrade

Deploy only a reviewed commit that meets the
[current server/runtime release gates](runtime-image-security.md). Source CI and
`pnpm check:compose` do not approve unresolved runtime findings. The latter
checks nine example configurations and signed upload origins offline; it neither
reads a private `.env` nor contacts your provider.

On a fresh installation, migrations prepare the limited `varda_app` role before
API/worker startup, then the gateway waits for API readiness. Confirm successful
migration logs, healthy worker and `/ready`, then verify signup/email, upload,
private and public delivery, a Vard, CLI login/pull and frozen CI on your actual
HTTPS origin. A healthy `/ready` alone checks the database, not the entire pilot.

For an existing installation, follow the
[upgrade and rollback procedure](operations.md#upgrade). Take and
verify an off-host database/object/secrets backup, stop gateway/API/worker to
close writers, build the selected commit, and run its migration successfully
before recreating those services. `depends_on` gates startup; it does not stop
already-running old services during migrations. Recreate the gateway too when
deploying a gateway image/configuration change. The gateway refreshes Docker DNS
for API and marketing upstreams, so replacing an upstream container does not
require a gateway restart to adopt its new IP. Inspect migration logs from this
deployment, not a previous successful run. Do not enable unattended AutoDeploy
for upgrades requiring this maintenance sequence. Keep the project name and
named volumes; `down -v` destroys them. Forward-only migrations mean rollback
may require the pre-upgrade backup, not merely an older image tag.

Dokploy references: [Compose setup](https://docs.dokploy.com/docs/core/docker-compose),
[Domains and Preview Compose](https://docs.dokploy.com/docs/core/docker-compose/domains).

## Recover an older gateway after an API redeploy

If the API reports `/ready` 200 on its new container IP but gateway logs show
`Connection refused` on an old IP, restart only the **gateway** service in
Dokploy. Older images resolved upstream addresses once at startup; rebuilding
and deploying the current gateway adds automatic Docker DNS refresh. This does
not restart PostgreSQL, run migrations or change storage. A brief 502 while the
API is actually unavailable during replacement is still possible; DNS refresh
cannot make an unavailable backend healthy.
