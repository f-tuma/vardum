# @vardum/shared

Wire types and accepted-format tables shared by the Vardum API, dashboard,
CLI and MCP server. Published because `@vardum/cli` and `@vardum/mcp` depend on
it at runtime; it carries no dependencies of its own.

This README describes shared **0.4.0**, used by CLI **0.8.0** and MCP **0.4.0**.
Check [release status and compatibility](https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md)
to confirm npm availability before installing this version. The historical
server compatibility fixture continues to use shared 0.2.0.

Shared 0.4.0 adds the guarded-editor wire contract: `VardEditorDefinition`
requires the opaque `revision` and each manual item's literal nullable
`pinnedVersionId`; `VardEditorItemInput` requires an existing mapping `id` or
`null`, plus an explicit nullable `versionId`. Keep saved pins separate from
resolved delivery versions. It retains `mediaStem`, `mediaOutputPath`, format
tables. This client batch keeps CLI schema 2 snapshots; the wire manifest remains
schema 1. It does not introduce schema 3.

CLI 0.8.0 and MCP 0.4.0 retain `workspace:^` dependencies in source; their release
archives require `@vardum/shared: ^0.4.0`, which npm resolves transitively.

For a direct consumer, **this installation targets shared 0.4.0** once the
release-status page confirms it is available:

```sh
npm install --save-exact @vardum/shared@0.4.0
```

```ts
import { mimeForFilename, supportedMimeTypes, type VardEditorDefinition } from "@vardum/shared";
```
