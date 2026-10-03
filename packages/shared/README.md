# @vardum/shared

Wire types and the accepted-format tables shared by the Vardum API, dashboard,
CLI and MCP server. Published because `@vardum/cli` and `@vardum/mcp` depend on
it at runtime; it carries no dependencies of its own.

The published client baseline uses shared **0.2.0**; see
[release compatibility](https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md#compatibility)
for the corresponding CLI/MCP versions and unreleased candidates.

```ts
import { mimeForFilename, supportedMimeTypes, type VardManifest } from "@vardum/shared";
```
