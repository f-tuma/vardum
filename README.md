# Vardum

Vardum is a self-hosted asset library for versioned images and video on
S3-compatible storage, with explicit file delivery into your projects.

## What you can do

- **Deliver assets through stable URLs.** Upload a new version or restore an
  earlier one without changing the asset's stable URL. New assets are private;
  workspace permissions and asset visibility control delivery.
- **Bring assets into a repository with Vards.** Map files, pin versions or
  include folders, then run `vardum pull` when you want to update the project.
  Commit the lockfile and use `vardum pull --frozen` to restore its checksummed
  snapshot in CI.
- **Manage the library through the app, CLI or MCP.** Upload assets, organize
  Vards and use image delivery transformations. Output recipes need the matching
  API and worker; installing a client alone does not add server capabilities.

Frozen delivery still needs the retained versions, server availability and valid
signing configuration. A public Vard does not make its private assets public.

## Guides

| Guide | Start here for |
| --- | --- |
| [Quick start](docs/guide/quick-start.md) | One file from a workspace into your project |
| [Concepts](docs/guide/concepts.md) | Assets, versions, Vards and permissions |
| [Use assets in a project](docs/guide/pull.md) | Updates, conflicts, lockfiles and CI |
| [MCP server](docs/guide/mcp.md) | Agent setup and guarded Vard editing |
| [Self-hosting](docs/guide/self-hosting.md) | Your server, database and S3 bucket |
| [Dokploy deployment](docs/guide/dokploy.md) | Compose deployment behind Traefik |
| [Operations](docs/guide/operations.md) | Backups, restores, upgrades and monitoring |

## Use an existing workspace

You need Node.js 22+ and access to a Vardum server and workspace. In the app,
upload an asset, create a Vard and map it to a project path. Keep the server URL,
workspace ID and Vard ID for setup.

From your project directory:

```sh
npm install --save-dev --save-exact @vardum/cli@0.8.3
npx vardum init
npx vardum login
npx vardum pull
```

Commit `vardum.json`, `.vardum.lock` and the package manifest and lockfile.
For CI, provide a workspace read key as `VARDUM_API_KEY`, then run:

```sh
npm ci
npx --no-install vardum pull --frozen --json
```

Try the runnable [first project](examples/first-project/README.md) for uploads,
folder rules and a frozen-pull verifier. Public npm packages provide clients;
you still need a provisioned workspace on your own or an existing server.

## Run your own server

The Compose stack runs PostgreSQL, migrations, the API, worker and web app.
Bring an S3-compatible bucket with presigned POST and CORS support, or use the
optional bundled RustFS service. Keep storage private and configure TLS and SMTP.

Follow [self-hosting](docs/guide/self-hosting.md) or
[Dokploy deployment](docs/guide/dokploy.md), then use the
[operations runbook](docs/operations.md) for upgrades and backups. Server/runtime
acceptance is tracked in the [readiness record](docs/production-readiness-2026-09-20.md#current-status).

The web app runs at `/app/`. Dokploy can serve the marketing site at the apex;
other deployments redirect the apex to the app. API, delivery and CLI server
URLs keep the origin without an `/app` suffix.

## Local development

Requires Node.js 22+, `pnpm@12.4.2` and Docker with Compose.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

The app opens at `http://localhost:5173/app/`, the API at `http://localhost:3000`,
and local email is captured by Mailpit at `http://localhost:8025`.
`pnpm dev` starts local database, storage and mail services and runs migrations.

For a remote development hostname, explicitly allow that exact hostname for
Vite in the shell that starts it:

```sh
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=dev.example.com pnpm dev
```

Also set `WEB_URL` in `.env` to the exact frontend origin, including scheme and
port, then restart development processes. `BETTER_AUTH_URL` is the separate
API/auth base URL. Use exact hostnames; do not enable an unrestricted host list.

## Contributing and checks

Make focused changes and run the checks relevant to them:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check:compose
```

See the [client release procedure](docs/npm-release.md) for package validation
and the [server procedure](docs/server-release.md) for production smoke tests.
Compose checks use examples and do not verify your provider, credentials or DNS.

## Published clients and compatibility

| Component | Current documented version |
| --- | --- |
| `@vardum/cli` | `0.8.3` |
| `@vardum/mcp` / `@vardum/shared` | `0.4.2` |
| Frozen snapshot schema | `2` (minimum CLI `0.6.0`) |

See [release evidence and upgrade order](docs/client-release-0.8.3.md) and the
[compatibility table](docs/npm-release.md) before changing clients or servers.

## Security and license

Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
Vardum is released under the [MIT License](LICENSE).
