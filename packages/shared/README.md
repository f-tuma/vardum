# @vardum/shared

Wire types and accepted-format tables shared by the Vardum API, dashboard,
CLI and MCP server. Published because `@vardum/cli` and `@vardum/mcp` depend on
it at runtime; it carries no dependencies of its own.

This README describes [shared **0.4.1**](https://www.npmjs.com/package/@vardum/shared/v/0.4.1),
used by CLI **0.8.1** and MCP **0.4.1**. This patch makes the package documentation
self-contained; it does not change the wire types or client snapshot schema.

Shared 0.4.0 adds the guarded-editor wire contract: `VardEditorDefinition`
requires the opaque `revision` and each manual item's literal nullable
`pinnedVersionId`; `VardEditorItemInput` requires an existing mapping `id` or
`null`, plus an explicit nullable `versionId`. Keep saved pins separate from
resolved delivery versions. It retains `mediaStem`, `mediaOutputPath`, format
tables. This client batch keeps CLI schema 2 snapshots; the wire manifest remains
schema 1. It does not introduce schema 3.

CLI 0.8.1 and MCP 0.4.1 retain `workspace:^` dependencies in source; their release
archives require `@vardum/shared: ^0.4.1`, which npm resolves transitively.

For a direct consumer, pin **shared 0.4.1**:

```sh
npm install --save-exact @vardum/shared@0.4.1
```

```ts
import { mimeForFilename, supportedMimeTypes, type VardEditorDefinition } from "@vardum/shared";
```

Types alone do not enable backend features. Editable Vard reads and mutations
require a server advertising `vardEditRevision: 1` at `GET /api/capabilities`
and implementing the guarded `/editor` endpoints. Folder-upload mutation requires
`folderUploadResume: 1`; importing uploaded files into a Vard also requires
`folderVardImport: 1`. The upload backend needs migrations through
`0015_upload_request_checksum.sql` and ready-version checksum metadata.

Private delivery still needs a workspace read key. Keep API keys out of source
control and client-side applications; this package contains no authentication,
credential storage or server upgrades.
