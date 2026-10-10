# @vardum/shared

Wire types and the accepted-format tables shared by the Vardum API, dashboard,
CLI and MCP server. Published because `@vardum/cli` and `@vardum/mcp` depend on
it at runtime; it carries no dependencies of its own.

This README describes shared **0.3.0**. It adds the exported `mediaStem` and `mediaOutputPath`
helpers used by the CLI and API for consistent media names and output suffixes.
The published client baseline uses shared **0.2.0**; see
[release compatibility](https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md#compatibility)
for the corresponding CLI/MCP versions and unreleased candidates.

CLI 0.7.0 and MCP 0.3.0 retain `workspace:^` dependencies in source; the release
archives require `@vardum/shared: ^0.3.0`, which npm resolves transitively.

```ts
import { mimeForFilename, supportedMimeTypes, type VardManifest } from "@vardum/shared";
```
