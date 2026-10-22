# Client 0.8.3: public output recipe contracts

**Candidate for VARD-112; not yet published or independently verified.**
The proposed batch is CLI **0.8.3**, MCP **0.4.2** and shared **0.4.2**, with
matching source tag **v0.8.3** after review and validation. At preparation time,
all three versions were absent from public npm. Check availability again before
publication. The active verified public guidance remains CLI 0.8.2 / MCP 0.4.1;
this candidate does not promote the gateway Copy setup pin.

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

## Required release proof

The candidate is ready for publication only after independent review, required
CI and the source validation-only Release run. The existing full candidate
production smoke must exercise the **installed** packages against its disposable
server before the run uploads its archives. The separate validation-download
job checks the same run's four downloaded files and repeats the targeted
installed-recipe proof without packing again.

The recipe proof covers a TypeScript consumer outside the monorepo, all new
shared fields and a rejected invalid renderer literal, installed MCP tool help,
actual guarded recipe saves and rendered PNG/SVG content, stable manual IDs and
pins, stale-write/read-key denial, and installed CLI schema-2 frozen restoration
after a live definition change. The new public batch must run this proof too;
the historical public compatibility fixture's editor skip is not evidence for
MCP 0.4.2.

A branch validation-only run and the final matching-tag run are distinct
batches. The final tag run must test and publish its **own** exact archives
through the existing Actions trusted publisher. The privileged publisher retains
its archive/registry verification; a separate read-only public-recipe job must
independently install the explicit new batch from public npm and pass the same
recipe proof. `verify-registry` alone checks archive bytes and basic installation,
not the guarded recipe lifecycle.

## Publication evidence

Pending. Record the approved commit/tree/tag, branch and final tag run IDs and
attempts, original artifact ID, all four file sizes/hashes, actual npm publication
times, independent public installs and recipe outcomes, and byte comparisons of
all four GitHub release assets. Do not label this batch published or promote
onboarding/UI pins until the final tag run, including public-recipe verification,
is successful. Sanitized evidence must not contain keys, cookies or signed URLs.

After that proof, install the exact CLI with
`npm install --save-dev --save-exact @vardum/cli@0.8.3` and pin MCP configuration
to `@vardum/mcp@0.4.2`. Existing schema-2 locks need no migration. Promotion of the
separate gateway constant needs its own reviewed source change and deployment;
npm publication does not establish the live Copy setup version or Musubi pilot
acceptance.

## Recovery

Preserve the final tag run's successful validation artifact. Recover an
interrupted publication only by rerunning failed jobs of that original run;
a new dispatch or full rerun repacks. Preflight skips only byte-identical already
published versions. Stop on missing original archives or conflicting bytes;
never move a published tag or overwrite/unpublish a version to make a test pass.
See [the source release procedure](npm-release.md#publish).
