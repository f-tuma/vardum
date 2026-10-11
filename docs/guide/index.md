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

- Published: `@vardum/cli` 0.8.0, `@vardum/mcp` 0.4.0 and `@vardum/shared` 0.4.0.
  This batch adds the complete folder plan and guarded MCP Vard edits.
- Frozen snapshots remain schema 2, with minimum CLI 0.6.0. Folder upload/import
  and guarded edits need their matching backend capabilities.
- See [0.8 release notes and upgrade order](../client-release-0.8.md),
  [historical 0.7 notes](../client-release-0.7.md) and [release status](../npm-release.md).
