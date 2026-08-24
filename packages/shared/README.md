# @vardum/shared

Wire types and the accepted-format tables shared by the Vardum API, dashboard,
CLI and MCP server. Published because `@vardum/cli` and `@vardum/mcp` depend on
it at runtime; it carries no dependencies of its own.

```ts
import { mimeForFilename, supportedMimeTypes, type VardManifest } from "@vardum/shared";
```
