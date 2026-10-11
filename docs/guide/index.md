# Vardum docs

One versioned library for images and video. Projects pull exact files and lock
them. Websites use stable URLs.

```text
 app ─┐
 cli ─┼─> library ──> Vard ──> repository
 mcp ─┘   versions     │       + .vardum.lock
                       │
                       └─────> website
                               stable URL
```

## Start here

| You want to | Read |
| --- | --- |
| Get a file into a repository | [Quick start](quick-start.md) |
| Understand the model | [Concepts](concepts.md) |
| Keep CI builds reproducible | [Use assets in a project](pull.md) |
| Serve files to a website | [Delivery](delivery.md) |
| Connect an agent | [MCP server](mcp.md) |
| Run your own instance | [Self-hosting](self-hosting.md) |

## Versions

- Published: `@vardum/cli` 0.7.0, `@vardum/mcp` 0.3.0 and `@vardum/shared` 0.3.0.
- Candidate: CLI 0.8.0, MCP/shared 0.4.0; unavailable on npm as of 2026-10-11.
  It adds the complete folder plan and guarded MCP Vard edits.
- Frozen snapshots remain schema 2, with minimum CLI 0.6.0. Folder upload/import
  and guarded edits need their matching backend capabilities.
- See [published 0.7 notes](../client-release-0.7.md),
  [0.8 candidate notes](../client-release-0.8.md) and [release status](../npm-release.md).
