# Client 0.8.3: public output recipe contracts

**Published and independently verified 2026-10-22 (VARD-112).** CLI **0.8.3**,
MCP **0.4.2** and shared **0.4.2** are available from public npm. Original archive
bytes, independent public installations, all seven public recipe checks and the
four assets of [release v0.8.3](https://github.com/f-tuma/vardum/releases/tag/v0.8.3)
are verified. Active guides and gateway source Copy setup now pin CLI 0.8.3;
MCP guidance pins 0.4.2. Production Copy setup still needs gateway deployment.

## Package changes

Shared 0.4.2 publishes the optional output recipe fields already implemented by
the matching server: `bg`, `pad`, `layer`, `darkLayer`, `darkColor`,
`render?: "v2"` and `format: "svg"`. They are available through the public
`Transformation` export. MCP 0.4.2 publishes corresponding transformation help
in `replace_vard_items`; it retains all 11 tools, required revisions, stable
manual IDs and literal nullable pins. Its SDK dependency is 1.32.1, compared
with 1.31.0 in the previous public package.

CLI 0.8.3 keeps its existing sync, adoption and frozen behavior. Its new archive
is necessary because it depends on shared `^0.4.2` and includes this batch's
package documentation. CLI and MCP source dependencies stay `workspace:^`;
pinned pnpm rewrites them to ordinary semver in the archives. No published
version, historical tag or retained archive may be replaced.

The CLI snapshot remains **schema 2**, the wire manifest remains **schema 1**,
and the minimum schema-2 consumption CLI remains **0.6.0**. The historical
server compatibility fixture remains CLI 0.6.0 / MCP 0.2.0 / shared 0.2.0.
Schema 3 is separate work.

## Recipes and server compatibility

A new SVG-to-raster recipe with an opaque background can explicitly opt into
the v2 renderer:

```json
{ "w": 256, "h": 256, "fit": "contain", "format": "png", "bg": "#f4f0e8", "pad": 12.5, "render": "v2" }
```

`bg` requires an explicit format. `pad` is a 0–45 percent inset on each edge,
with at most two decimals; positive values require both dimensions, a format
and contain fit. SVG output supports the passive geometric source subset,
contain fit and no `q`. `layer` selects an existing SVG group while preserving
its source canvas. Paired `darkLayer` and `darkColor` produce SVG dark-mode
color adaptation for filled shapes in that group. The server validates source
types and all combinations.

`render: "v2"` requires an SVG source, a raster format and `bg`. Omit `render`
on an existing recipe to preserve its renderer identity; this release does not
silently upgrade mappings or frozen locks. Legacy and v2 output identities are
separate. See [bounded SVG derivatives](svg-derivatives.md) and
[safe-area padding](output-padding.md).

These fields require the matching API and worker/renderer implementation from
PRs #58–#61 and the VARD-111 SVG canvas admission fix in
[PR #63](https://github.com/f-tuma/vardum/pull/63).
`GET /api/capabilities` with `vardEditRevision: 1` establishes only guarded
editor support. It does **not** advertise SVG, safe-area, adaptive-color or v2
rendering support. Installing the new npm clients does not upgrade a server.
Record the actual tested server source/image with the release evidence.

Editable reads and update/replacement/delete still need `vardEditRevision: 1`
and dedicated `/editor` routes. Upload mutations still need
`folderUploadResume: 1`; Vard imports also need `folderVardImport: 1` and their
existing migration `0015` baseline. Follow the server release's full migration
order when deploying newer API/worker source. This client batch adds no
capability protocol or migration and does not certify a server artifact.

A normal pull intentionally resolves new recipes; review and commit its files
and lock. Frozen restoration preserves the captured membership, versions,
transformation URLs and checksums. It still requires retained, reachable bytes,
valid signatures and appropriate read permission. There is no new retention or
source-rename guarantee and no fallback to latest after a checksum failure.

## Publication evidence

[PR #64](https://github.com/f-tuma/vardum/pull/64) was independently reviewed at
`dcff7a847a6a6d3dad6da1a9e6a692292da5b3e5`.
[CI 39788781405](https://github.com/f-tuma/vardum/actions/runs/39788781405),
[job 119858920187](https://github.com/f-tuma/vardum/actions/runs/39788781405/job/119858920187),
passed all **26** steps on virtual merge
`b00f92fac3215d7aa066f71a9748c8f1b8b33e19`. The actual squash commit is
`2cd410486e7a7493946f09b6f8b5254bfba9aeaa`. Reviewed head, CI virtual merge and
actual squash have the identical tree
`fe1704af880a16e3b7d1d41998e20ba843cdbdbd`.

Tag `v0.8.3` is a **lightweight** reference directly to that squash commit and
tree; it has no annotated tag object or annotated tag signature. The release
source is the approved squash commit.

### Actual publication path

[Branch validation-only run 39788802860](https://github.com/f-tuma/vardum/actions/runs/39788802860),
attempt **1**, ran on the reviewed head. Its
[validate job 119859003314](https://github.com/f-tuma/vardum/actions/runs/39788802860/job/119859003314)
passed all **22** steps, including installed recipes and clean-stack restore.
The separate
[validate-download job 119867493568](https://github.com/f-tuma/vardum/actions/runs/39788802860/job/119867493568)
failed before a runner started because of GitHub account billing. Hosted
publication/public-proof jobs were skipped. That failure remains recorded.

The owner explicitly approved local downloaded-batch verification and direct
npm publication, then separately approved the matching tag and GitHub release.
The exact original branch artifact was reused; no replacement batch was packed.
Local downloaded-batch installs passed **12** adoption checks and all **seven**
recipe groups before publication. Direct npm publication then verified anonymous
registry bytes for all three versions; separate public installations, adoption
and seven-group public recipe verification passed afterwards.

There is **no final tag Actions validation, trusted-publisher or
`verify-public-recipes` job result claimed for this release**. Any workflow
triggered incidentally by the tag is separate from this recorded proof. The
usual Actions procedure remains in [npm releases](npm-release.md#publish).

| Evidence | Recorded identity |
| --- | --- |
| Original npm artifact | **12430488434**, `npm-dcff7a847a6a6d3dad6da1a9e6a692292da5b3e5`, branch run **39788802860**, attempt **1**, created `2026-10-22T13:55:34Z` |
| Original downloaded ZIP | **64,946 bytes**, SHA-256 `65d4fd1954e7a6c2671207d732217947c5891dc2fac9d95da379017f97cbb955` |
| Direct publication receipt | `manual-publication.json`, completed `2026-10-22T14:28:17.187Z`; original files unchanged |
| Independent public installs/adoption | `manual-public-adoption.json`, completed `2026-10-22T14:28:43.578Z`; separate projects/configs/caches |
| Toolchain | Node **22.23.3**, npm **12.2.1** |
| Temporary publication credentials | Revoked by successful `npm logout`; isolated temporary configuration removed, recorded `2026-10-22T14:29:06.744958Z`; package 2FA unchanged |

The original artifact contains exactly these four files. Their recorded bytes
and hashes match the published npm tarballs where applicable and all downloaded
GitHub release assets:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `release.json` | 713 | `2a4bae809f140d8ce41e544010ead86508003e6cef74a78c59f13f2eaeb7d120` |
| `vardum-cli-0.8.3.tgz` | 45,597 | `0eba92cff2b70225e83879e7bb7a84127a038900798c765ed25c0cbaa0031c0d` |
| `vardum-mcp-0.4.2.tgz` | 13,156 | `e45e25103751a48eb1e6357b066dc7df24081c2679a1d5dba89631149129a964` |
| `vardum-shared-0.4.2.tgz` | 5,237 | `3e186dd33c8fe6b8e8b9bbee5521a82d381ccc5274aa38d6db8a5b3a3d440513` |

| Archive | SHA-512 integrity |
| --- | --- |
| `vardum-shared-0.4.2.tgz` | `sha512-0CLAlsKcFICDLipFIt1M/62AHoYb3STRmViGCqOqSEIV5S4VxdURGkOccK1ciWUiSf4AWL1F3S9i5YE694Jniw==` |
| `vardum-cli-0.8.3.tgz` | `sha512-t5z6mcq6KKtaeKaPQNEpPVzf3Dqi4J41a8HqaBVpZ4MBorUcuGfQ/fT6IFoS8hV8I4wpcJKI8AQ5pFAmOofaWw==` |
| `vardum-mcp-0.4.2.tgz` | `sha512-E+lCf0GVqAymUJn57IgW2Cz5rCQxgNJvEELlMNxem4cPwrUTu9YRBr4BlK169KXMFPJDxlxuJQjNz1PymMK0SQ==` |

`release.json` is the manifest and has no npm archive integrity of its own.
Anonymous npm metadata and actual tarball downloads matched every archive size,
SHA-256 and SHA-512 integrity. Observed npm publication times were:

| Package | npm publication time (UTC) | Registry bytes |
| --- | --- | --- |
| [@vardum/shared 0.4.2](https://www.npmjs.com/package/@vardum/shared/v/0.4.2) | `2026-10-22T14:24:14.099Z` | [exact tarball](https://registry.npmjs.org/@vardum/shared/-/shared-0.4.2.tgz) |
| [@vardum/cli 0.8.3](https://www.npmjs.com/package/@vardum/cli/v/0.8.3) | `2026-10-22T14:25:17.083Z` | [exact tarball](https://registry.npmjs.org/@vardum/cli/-/cli-0.8.3.tgz) |
| [@vardum/mcp 0.4.2](https://www.npmjs.com/package/@vardum/mcp/v/0.4.2) | `2026-10-22T14:28:06.413Z` | [exact tarball](https://registry.npmjs.org/@vardum/mcp/-/mcp-0.4.2.tgz) |

Independent empty consumer projects installed only the named CLI or MCP from
public npm. Their executables reported **0.8.3** and **0.4.2** respectively;
each resolved shared **0.4.2** transitively. Both packed dependency declarations
use ordinary `^0.4.2` semver, without workspace or local-file references.

### Public recipe and runtime proof

The retained `manual-public-recipes-summary.txt` explicitly reports
`registry: public`, CLI **0.8.3**, MCP **0.4.2**, compatibility CLI **0.6.0**, and:

| Result group | Result |
| --- | --- |
| `publicTypes` | passed |
| `mcpHelp` | passed |
| `guardedRecipes` | passed |
| `httpOutputs` | passed |
| `guards` | passed |
| `legacyAndFrozen` | passed |
| `crossVersionFrozen` | passed |

The public proof compiled positive/negative TypeScript contracts outside the
monorepo, inspected installed MCP help, saved guarded recipes with stable manual
IDs and literal pins, decoded actual PNG/SVG output, checked denial/stale writes,
and restored schema-2 frozen output after live changes. It also restored the
same lock across public CLI 0.6.0 and the new CLI. The historical compatibility
fixture's guarded-editor skip is not used as new MCP proof.

The disposable public-recipe server used source
`2cd410486e7a7493946f09b6f8b5254bfba9aeaa`, tree
`fe1704af880a16e3b7d1d41998e20ba843cdbdbd`, with local image identities:

- API: `sha256:0e377138f2606e29382a0902137bf632fa1c6eb30d45f5a88e249bcdabe3a9c8`.
- Gateway: `sha256:38b53c112c1289b140db98afd9a7fd81569f704716f14e01c4dc8df7601e1f88`.

The exact disposable project was cleaned; no containers remained. These are
tested source/local image identities, not a promoted server release or provider
acceptance. Automated login used a simulated browser grant; it does not establish
a new person's first run, deployed Copy setup or Musubi adoption.

The branch validation's actual clean-stack backup/restore passed with **49
objects / 17,854,409 object bytes**. Its sanitized runtime artifact **12431073250**
has downloaded ZIP **12,029 bytes**, SHA-256
`0ddae4ea4a1085e391b4849c4486fd01929d01610c2348ced80642c3feb234ab`.
The retained projection has exactly `runtime-summary.json`, `runtime-summary.txt`
and `checksums.txt`; the summary hashes are respectively
`0bc245755ffeb02236a2dfb3656648305e74142ecfdf4ecc01948b613d86d7de` and
`f73bcffa8b543a9a0231a49862bd3f20d58576f686858406b3b4cf966109796e`.
It records the reviewed source/tree, `sourceDirty: false`, workflow success and
complete evidence. Findings still require vendor assessment; the projection
provides neither offline replay nor release certification. Separate deployed
SVG/AVIF/database-role results are not individually recorded. This does not close
server/runtime, provider or existing risk-acceptance work.

### GitHub release assets

GitHub release **420827106** has exactly four assets. Every asset was downloaded
and byte-compared with the original artifact files above; IDs and sizes were
observed at `2026-10-22T14:33:29.415261Z`:

| Asset | Asset ID | Bytes |
| --- | --- | --- |
| `release.json` | **666116756** | **713** |
| `vardum-cli-0.8.3.tgz` | **666116825** | **45,597** |
| `vardum-mcp-0.4.2.tgz` | **666116853** | **13,156** |
| `vardum-shared-0.4.2.tgz` | **666116790** | **5,237** |

The retained `manual-github-release.json` and `manual-final-metadata.json` record
the actual release/tag/assets and public registry observations. Earlier candidate
receipts remain historical; they do not replace these publication results.

## Upgrade order

1. Verify the deployed API and worker contain the matching recipe implementation
   from PRs #58–#61 and #63. Apply the server's full migration sequence and check
   the relevant upload/import/editor capabilities before enabling those actions.
   `vardEditRevision: 1` alone does not establish recipe rendering support.
2. Install exact CLI `@vardum/cli@0.8.3` and MCP `@vardum/mcp@0.4.2`; review the
   resulting dependency lock changes. Shared 0.4.2 resolves transitively.
3. Run a normal pull deliberately when adopting live recipe/version/membership
   changes; review and commit the resulting files and snapshot. Existing schema-2
   locks need no migration. Preserve them for frozen restore of captured output.
4. Deploy the promoted gateway source separately when authorised to update live
   Copy setup. Source pin promotion and npm publication do not deploy the gateway,
   certify a server/provider or complete Musubi/human acceptance.

Frozen restore still depends on retained reachable bytes, valid signatures and
read permission, and never falls back to latest after checksum failure.

## Recovery

This published batch is immutable. Preserve original artifact **12430488434**,
its four files and the recorded verification receipts; do not repack to replace
missing evidence, move tag `v0.8.3`, overwrite/unpublish versions or replace
release assets to make a check pass. Any conflicting bytes require investigation.
Future Actions releases use the [documented original-run failed-job recovery](npm-release.md#trigger-and-verify);
this release's direct-publication evidence must not be relabeled a tag-run batch.
