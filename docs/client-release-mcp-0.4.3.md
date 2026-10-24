# MCP 0.4.3 security patch

## Publication status

Candidate preparation; not yet published. Active installation guidance remains on
verified MCP 0.4.2 until the new immutable archive is published and independently
verified from npm. This document does not announce a server release or schema 3.

## Scope

MCP 0.4.3 packages the input-validation fix already reviewed in
[PR74](https://github.com/f-tuma/vardum/pull/74): exact Zod 4.6.6 and its required
string-keyed record API. Published MCP 0.4.2 declares `zod: ^3.24.0`; deploying
the server does not change that immutable npm package. The
[Zod advisory](https://github.com/colinhacks/zod/security/advisories/GHSA-mrhx-c7xc-m3w5)
is addressed by the v4 parser, not the compatibility `zod/v3` entry point.

MCP SDK 1.32.1, all eleven tools, guarded editing, rich output recipes, schema 2
snapshots and backend capability requirements remain. The SDK's v4 JSON Schema
conversion expresses UUID constraints and string record keys explicitly; its
object metadata differs from the previous v3 converter. Runtime unknown-key
stripping remains. Existing stdio and actual installed-package checks cover the
advertised schemas and guarded tool behavior.

## Exact package batch

| Package | Version | Archive origin |
| --- | --- | --- |
| `@vardum/shared` | 0.4.2 | Original published archive, verified against registry integrity and bytes |
| `@vardum/cli` | 0.8.3 | Original published archive, verified against registry integrity and bytes |
| `@vardum/mcp` | 0.4.3 | New pinned-pnpm archive from the reviewed clean source |

Only MCP is newly published. The current shared source includes additive types
introduced after shared 0.4.2; repacking it under that version would produce
conflicting bytes. Preserve both existing archives and their historical READMEs.
MCP uses the existing shared runtime export and type contracts; validate the new
MCP with the actual installed shared 0.4.2 archive.

Assemble the three archives and the normal schema-1 `release.json` in a new empty
directory. Use pinned pnpm to pack only `apps/mcp`, copy the two verified original
published archives, and compute each integrity from the final bytes. Keep source,
origin and validation receipts outside that four-file directory. Existing
`release-packages.mjs check`, `preflight`, installed-client checks and `publish`
apply unchanged. Preflight must verify every existing registry archive before any
write; publication skips byte-identical versions and publishes only missing MCP.
Never replace or republish CLI 0.8.3, shared 0.4.2 or MCP 0.4.2.

The source-tag workflow derives its tag from the CLI version. Do not dispatch it
using the old `v0.8.3` tag, move that tag, or replace its GitHub release assets for
this MCP-only patch. Use the owner's approved direct npm publication path after
review and acceptance of this exact archive batch.

## Acceptance and upgrade

Before publication, check frozen dependencies and the unchanged advisory gate,
MCP types/tests/build, the exact archive manifest and README, and independent
installation with a real lockfile and audit. Confirm installed Zod 4.6.6 and the
active v4 parser. Zod 4 still ships v3 compatibility files; their presence is not
an installed v3 package or evidence that MCP uses its parser.

Run the existing complete source-mode production smoke with `SMOKE_RELEASE_DIR`
pointing to this exact batch. This checks all eleven tool behaviors, guarded
editing and current recipes. `SMOKE_PUBLIC_CLIENTS=1` selects the historical
CLI 0.6/MCP 0.2 server baseline and is not acceptance of this new MCP.

After publication, verify actual registry tarball bytes before independent public
installs. Use the existing recipe-only smoke with
`SMOKE_INSTALLED_RECIPES_ONLY=1`, `SMOKE_RECIPE_REGISTRY=public` and the same
`SMOKE_RELEASE_DIR` to verify current tools, recipe saves, conflicts, permissions
and schema 2 frozen outputs. Only then promote active MCP setup guidance to
`@vardum/mcp@0.4.3`. CLI and shared installation pins remain unchanged.

No new backend capability, migration or live asset edit is required. Existing
private/public permissions, snapshot retention limits and native/vendor server
release conditions remain applicable.
