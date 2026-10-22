# @vardum/shared

Wire types and accepted-format tables shared by the Vardum API, dashboard,
CLI and MCP server. Published because `@vardum/cli` and `@vardum/mcp` depend on
it at runtime; it carries no dependencies of its own.

This README describes [shared **0.4.2**](https://www.npmjs.com/package/@vardum/shared/v/0.4.2),
used by [CLI **0.8.3**](https://www.npmjs.com/package/@vardum/cli/v/0.8.3) and
[MCP **0.4.2**](https://www.npmjs.com/package/@vardum/mcp/v/0.4.2).
It publishes the optional `Transformation` fields `bg`, `pad`, `layer`,
`darkLayer`, `darkColor`, `render: "v2"` and the `"svg"` output format.
Client snapshot and manifest schemas are unchanged.

Shared 0.4.0 adds the guarded-editor wire contract: `VardEditorDefinition`
requires the opaque `revision` and each manual item's literal nullable
`pinnedVersionId`; `VardEditorItemInput` requires an existing mapping `id` or
`null`, plus an explicit nullable `versionId`. Keep saved pins separate from
resolved delivery versions. It retains `mediaStem`, `mediaOutputPath`, format
tables. This client batch keeps CLI schema 2 snapshots; the wire manifest remains
schema 1. It does not introduce schema 3.

CLI 0.8.3 and MCP 0.4.2 retain `workspace:^` dependencies in source; their release
archives require `@vardum/shared: ^0.4.2`, which npm resolves transitively.

For a direct consumer, pin **shared 0.4.2**:

```sh
npm install --save-exact @vardum/shared@0.4.2
```

```ts
import { mimeForFilename, supportedMimeTypes, type Transformation, type VardEditorDefinition } from "@vardum/shared";

const raster: Transformation = {
  w: 256, h: 256, fit: "contain", format: "png",
  bg: "#f4f0e8", pad: 12.5, render: "v2",
};
const vector: Transformation = {
  format: "svg", layer: "logo", darkLayer: "logo", darkColor: "#e8e4d9",
};
```

For a new SVG-to-raster output with `bg`, choose `render: "v2"` explicitly.
Omission retains the legacy renderer identity. Positive `pad` requires `w`, `h`,
an explicit format and `fit: "contain"`. SVG output and group/color selection
require a supported passive geometric SVG; `darkLayer` and `darkColor` are paired,
and SVG output does not accept `q`.

Types alone do not enable backend features. These recipe fields need a matching
API and renderer; `vardEditRevision: 1` does not advertise transformation support.
Existing recipes and frozen snapshots are not automatically migrated.
Editable Vard reads and mutations
require a server advertising `vardEditRevision: 1` at `GET /api/capabilities`
and implementing the guarded `/editor` endpoints. Folder-upload mutation requires
`folderUploadResume: 1`; importing uploaded files into a Vard also requires
`folderVardImport: 1`. The upload backend needs migrations through
`0015_upload_request_checksum.sql` and ready-version checksum metadata.

Private delivery still needs a workspace read key. Keep API keys out of source
control and client-side applications; this package contains no authentication,
credential storage or server upgrades.
