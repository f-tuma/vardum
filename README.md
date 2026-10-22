# Vardum

Developer-first digital asset manager for S3-compatible storage.

See the [product direction](docs/product-direction.md) for the target users,
core workflow, first milestone, and planned templates and usage monitoring.
That document describes intended behavior, not a list of shipped features.

See [current readiness status](docs/production-readiness-2026-09-20.md#current-status)
(client status updated 2026-10-22) for published clients and open server/runtime acceptance.
The same document preserves the initial September 20 audit and dated remediation
evidence. [Published CLI 0.8.3, shared 0.4.2 and MCP 0.4.2](docs/client-release-0.8.3.md)
publish output recipe types and MCP help, retaining explicit lock-only adoption,
standalone setup, schema 2, the complete folder plan and guarded MCP Vard editing.
Registry bytes, independent public installs, seven public recipe checks and all
four GitHub release assets are verified. New project setup pins CLI 0.8.3;
MCP setup pins 0.4.2. Recipes need the matching API and worker; see
[upgrade order](docs/client-release-0.8.3.md#upgrade-order).
Copy setup uses the verified CLI pin in gateway source;
production needs the matching gateway deployment. The
[0.7 release record](docs/client-release-0.7.md) and the 0.6/0.2/0.2 compatibility
fixture remain available. The separate schema 3 draft remains unmerged and unpublished.

The workspace [Usage page](docs/known-usage.md) records explicitly known projects,
destinations and manual checks separately from current source versions. It does
not crawl websites or automatically update connected repositories.

## Development

Requires Node.js 22+, pnpm, and Docker.

```sh
cp .env.example .env
pnpm install
pnpm dev
```

The API uses `WEB_URL` as its explicit frontend origin for CORS and authentication.
It defaults to `http://localhost:5173`. For a remote development frontend, set
`WEB_URL` in `.env` to its exact origin, including scheme, host and port (for
example, `https://dev.example.com:5173`), then restart the development processes.
Development mode does not add another remote origin.

`BETTER_AUTH_URL` is the API/auth base URL, configured separately from the frontend
origin; it defaults to `http://localhost:3000`. Better Auth builds its own trusted
origin set from this base URL and any `BETTER_AUTH_TRUSTED_ORIGINS` environment
setting. These do not extend the API CORS allowlist.

## Outbound email

Docker Compose starts Mailpit for local email capture. The default `.env.example`
sends SMTP to `localhost:1025`; inspect messages at <http://localhost:8025>.

For production, replace those values with your SMTP provider:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=vardum
SMTP_PASSWORD=replace-me
SMTP_FROM="Vardum <noreply@example.com>"
```

`SMTP_USER` and `SMTP_PASSWORD` are optional, but must be provided together.
Use `SMTP_SECURE=true` for implicit TLS (normally port 465); port 587
upgrades with STARTTLS when offered. Without `SMTP_HOST`, mail-dependent
features remain disabled.

## Production / self-hosting

The production stack runs PostgreSQL, migrations, API, worker and a static
nginx web container, and stores objects in a bucket you bring:

```sh
cp .env.production.example .env.production
# Replace every secret and fill in the bucket, its keys and the public APP_URL.
docker compose --env-file .env.production -f compose.production.yml up -d --build --wait
curl --fail http://localhost:8080/ready
```

The example file is written for Hetzner Object Storage and shows Amazon S3
beside it. An external provider must support signed POST policies, CORS, and
the object operations listed in
[storage compatibility](docs/operations.md#object-storage-compatibility-and-rustfs-upgrade);
validate it before deployment. Browsers upload straight into the
bucket with a presigned POST, so `S3_PUBLIC_ENDPOINT` must be reachable from
the public internet and must be the origin the generated URL actually carries —
with AWS that host is bucket-prefixed. `VITE_UPLOAD_ORIGINS` only overrides
development upload-origin validation; it does not configure bucket CORS.
Providers that do not serve virtual-hosted buckets need
`S3_FORCE_PATH_STYLE=true`.

For a single box with no object store of its own, `--profile rustfs` starts
RustFS alongside the app and treats `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` as
its root credentials. All templates pin RustFS 1.0.1 by digest; this is the
minimum supported bundled version for large presigned POST uploads. Existing
RustFS installs need the [storage upgrade procedure](docs/operations.md#object-storage-compatibility-and-rustfs-upgrade):

```sh
compose="docker compose --env-file .env.production -f compose.production.yml"
$compose --profile rustfs up -d --wait rustfs   # storage first
$compose --profile rustfs run --rm rustfs-init  # create the bucket once
$compose up -d --build --wait                   # then the app, without the profile
```

Storage is brought up on its own because `up --wait` aborts as soon as any
container in the wait set has exited, and the bucket-creating one always has.
An external bucket needs none of this — it is the single `up` above.

Use separate URL-safe `POSTGRES_PASSWORD` (administrator/migrator) and
`POSTGRES_APP_PASSWORD` (API/worker) secrets. The runtime secret needs at least
24 letters, digits, underscores or hyphens; `openssl rand -hex 32` works.
The one-shot migrator prepares application tables, pg-boss and the limited
`varda_app` role before API/worker startup. Production services reject an
administrator or schema-owning connection. `/health` is the liveness endpoint;
`/ready` also verifies PostgreSQL. Existing installs must follow the
[database-role upgrade](docs/operations.md#runtime-database-role-upgrade).

Stop the stack without deleting data:

```sh
docker compose --env-file .env.production -f compose.production.yml down
```

Run the disposable fresh-install check with:

```sh
bash scripts/smoke-production.sh
```

The [server candidate procedure](docs/server-release.md) prepares and validates
a portable bundle with the already-published clients, without publishing npm packages.

Backup, restore and upgrade procedures are documented in
[`docs/operations.md`](docs/operations.md).

## Dokploy

Two further Compose files deploy the same stack on Dokploy, where Traefik
already terminates TLS:

| File                      | Use                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `compose.dokploy.yml`     | Production. App at `/` and `/app`; an optional marketing deployment can serve the apex. |
| `compose.dokploy.dev.yml` | Branch deployment. No marketing site, so the dev domain opens the app directly.                      |

Copy `.env.dokploy.example` into the Dokploy environment editor and expose one
Domain: the app hostname on service `gateway`, container port 80. Objects live in
the bucket named by those variables, so there is no storage service to publish
unless you set `COMPOSE_PROFILES=rustfs` to run one in the stack.

Use **Docker Compose**, not Docker Stack; these templates build from source and
use migration completion dependencies. Follow the generic
[Dokploy install and upgrade guide](docs/dokploy.md) for storage initialization,
email verification, custom domains and upgrades. `pnpm check:compose` checks the
example configurations, application schema and offline upload URL generation;
it does not contact a provider or validate real secrets.

In production the marketing site is its own Dokploy application, joined to
`dokploy-network` and given no Domain of its own. Point `MARKETING_UPSTREAM` at
its service alias; `docker/nginx.marketing.conf.template` proxies `/` there and
keeps `/api/*`, `/w/*` and the client's own routes on this stack. Leave it unset
until that application exists and the apex serves the app instead. That template
is included in the Dokploy gateway image, without a repository bind mount. It
lists the client routes explicitly — a route added to `apps/gateway/src/main.tsx`
and not to the template quietly serves the marketing 404.

## Organizations and workspaces

Organizations own members and roles and may contain multiple workspaces. Only
organization owners can create workspaces; editors and viewers inherit their
asset permissions across every workspace in the organization.

Organization creation is enforced by the API through `ORGANIZATION_CREATION`:
`allowlist` (recommended), `open`, or `disabled`. For `allowlist`, set a
comma-separated `ORGANIZATION_CREATOR_EMAILS`. An allowlisted account must also
verify its email before it can create an organization. Configure SMTP for the
bootstrap administrator, sign up, then follow the verification link. The app
offers resend and verification checks; without SMTP it asks for administrator
help and keeps creation blocked. Existing verified accounts can still create
organizations if SMTP is later disabled.

`open` deliberately allows every signed-in account to create organizations,
including unverified accounts; use it only on a trusted instance. `disabled`
prevents all new organizations. Neither policy removes existing memberships.
See [organization bootstrap and upgrades](docs/operations.md#organization-bootstrap-and-email-verification).

## Vards and CLI sync

A Vard is a project manifest assembled in the workspace UI. Each item maps an
asset to a repository-relative output path and may follow latest, pin a version,
or request a delivery transformation. Commit the generated `vardum.json`, then
use `vardum pull` to explicitly refresh assets and the `.vardum.lock` snapshot.
Commit both files; CI uses `vardum pull --frozen` with CLI 0.6.0 or newer
to consume the locked file set without fetching the current Vard.
CLI 0.8.3 is available on npm and is recommended for new projects; see [release status](docs/npm-release.md).
Older CLI builds cannot safely maintain snapshots.
Locked delivery still depends on version retention, valid signing and server
availability. `vardum update` updates the CLI, not assets.

Private files, private Vards and push operations need a workspace key. `vardum login`
authorizes the machine in the browser and stores one scoped to your own
permissions; `VARDUM_API_KEY` overrides it, so CI stays explicit.

Try the [three-file first project](examples/first-project/README.md) for private
uploads, a recursive folder rule and a verified frozen pull.

See [`apps/cli/README.md`](apps/cli/README.md) for setup, conflict handling,
lockfiles, safe deletion and bulk folder push.

## Recursive folder inclusion

In the Vard editor, add a **Folder rule** from `brand/` to `assets/brand/`.
A ready source `brand/icons/logo.svg` becomes `assets/brand/icons/logo.svg`.
Rules include current ready originals recursively, preserve the relative suffix,
and generate read-only outputs separately from manual pins, transformations and
writable mappings. Pending files are excluded until ready. Empty source or output
prefixes mean workspace or project root respectively; empty and nonexistent
folders are valid. Prefixes are literal safe relative directories ending in `/`,
not globs or excludes.

Up to 64 rules, 255 characters per prefix, and **1,000 combined manual + generated
outputs** are supported (output paths at most 500 characters). Explicit + rule,
rule + rule, case/Unicode-equivalent and file/directory collisions fail the entire
resolution; there is no precedence or truncation. The editor keeps configuration
editable when its separate live resolved preview fails, so you can repair paths
or reduce rules. A new private member makes an otherwise public Vard's entire
anonymous manifest unavailable; workspace readers can still access it.

The live preview is not your committed snapshot. There is no background project
sync: normal `vardum pull` intentionally resolves changed membership and versions;
`vardum pull --frozen` consumes only the committed snapshot. Removing a rule leaves
manual mappings and source assets intact. Choose **`--delete` on the
membership-updating pull** to remove stale tracked local files. A normal pull
without deletion drops stale tracking but leaves those files on disk; a later
`--delete` cannot discover them, so deliberate manual cleanup is required.

This requires the matching folder-aware API/gateway. MCP 0.4.2 requires
`vardEditRevision: 1` and the original revision for updates, replacements and
deletion. See [release status](docs/npm-release.md),
[MCP rule operations](apps/mcp/README.md#folder-rules) and
[migration/rollback guidance](docs/operations.md#folder-rule-upgrade).

## Asset visibility

See [asset browsing and search](docs/asset-browser.md) for pagination, loaded
counts, retry/refresh behavior and the opt-in browser HTTP contract.

New assets are **private**, including uploads through the UI, CLI or MCP and
bucket imports. The upgrade preserves existing files as public. Asset visibility
is independent of a Vard's public manifest setting. Owners and editors can change
it in asset settings; automation can PATCH
`/api/workspaces/:workspaceId/assets/:assetId/visibility` with
`{"isPublic": true}` or `{"isPublic": false}` using a key with `publish` permission.
MCP exposes the same operation as `set_asset_visibility`; `list_assets` reports
`isPublic`. Changes are workspace-scoped and audited; versions, checksums and
locked URLs do not change.

Private originals and signed variants require workspace read access on every new
delivery request, including immutable URLs, redirects, HEAD and ranges. A
transformation signature is not authorization. Browser previews and Open links
use the canonical app origin for private files so the session cookie works;
credentials never go in URLs. Public files remain anonymously readable.

A public Vard does not publish its files. If **any** mapped asset is private, the
entire anonymous manifest is unavailable, not a filtered partial package.
Authenticated workspace readers can still use the complete manifest. Manifests
and private/error delivery responses are non-cacheable.

Storage must be private: public bucket/object permissions or a separate storage
CDN can bypass the application. Previously public responses may remain in
browsers or shared caches for their original lifetime (up to a year). Making a
file private cannot revoke those copies, downloaded files, or existing offline
build outputs. See [operations](docs/operations.md#asset-visibility-upgrade) for
upgrade order, the workspace-key allowance change and safe rollback constraints.
This is a bounded delivery slice, not completion of the product milestone.

## Custom domains

Set `CUSTOM_DOMAIN_TARGET` to the public hostname that routes delivery traffic
to Vardum. Workspace owners then configure a domain in Settings and add the
TXT challenge plus CNAME shown there. Verification hinges on the TXT record:
a domain proxied through Cloudflare answers with flattened A records, so its
CNAME is invisible to us even when traffic arrives correctly. Only verified
domains are used for host routing; canonical `/w/{workspaceSlug}/{key}` URLs
remain available.

TLS and DNS are intentionally handled by Cloudflare or your reverse proxy. The
proxy must preserve the original `Host` header, and it needs a certificate for
each custom domain — behind Cloudflare that means either proxy mode with
Flexible SSL or an origin certificate the proxy serves for that hostname.

## Releasing the packages

Three workspace packages are published to npm: `@vardum/shared` (wire types and
the accepted-format tables), `@vardum/cli` and `@vardum/mcp`. The API and the
gateway are private and stay in the repository.

Prepare archives with the repository's pinned pnpm, then test and publish those
same archives. `npm pack` from a source workspace is blocked because it leaves
`workspace:` dependencies unresolved. The `Release` workflow requires a tag
matching the CLI version, runs unit/integration/production tests, installs the
candidate CLI and MCP independently, then publishes shared → CLI → MCP from
the exact tested archives downloaded from that same run. A branch validation-only
run and a final tag run produce distinct tested artifact batches. If publication
fails, rerun only failed jobs in the original tag run so its validation archive
is reused; a new dispatch or full rerun repacks. It checks registry bytes and
fresh installs again after publication.

See [the release procedure and compatibility table](docs/npm-release.md) for
published versions, candidate gates, exact commands, partial-release recovery
and npm setup.
Publishing remains an explicit action; preparing or testing archives does not
publish them. Packages use the public npmjs registry.

## Versions

Every upload is a permanent version and the stable URL redirects to whichever
one is current. The asset page lists the history and restores any ready version
by moving that pointer; nothing is rewritten, and the restore is recorded as
`asset.version_restored` in the audit log.

## Importing an existing bucket

Objects already sitting in the bucket can be adopted from the assets page under
**Import from S3**, or through
`POST /api/workspaces/{id}/imports` with a `source` prefix. Each object is
_copied_ into Vardum's own layout and then ingested, so deleting the asset later
never touches your original file. Vardum's `originals/` and `derived/` prefixes
are refused, and objects whose name or type cannot become a valid asset are
counted as skipped rather than renamed. One call handles one page of the
listing and returns `nextToken` for the next.

## API reference

The API serves its own OpenAPI 3 document at `/api/openapi.json`, generated
from the same Zod schemas the routes validate with, so it cannot drift from the
implementation.

## Delivery analytics

The Overview records successful `GET` content responses and shows a 30-day UTC
series for originals and transformations. These are response requests, not
proof that the client completed a download. Transformed responses also record
whether the variant came from the S3 cache, which the Overview and each asset
page report as a cache ratio. Raw events are retained for 90 days and removed
daily by the worker.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
Release history is available in [`CHANGELOG.md`](CHANGELOG.md).

## License

Vardum is released under the [MIT License](LICENSE).
