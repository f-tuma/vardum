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

- On npm: `@vardum/cli` 0.7.0, `@vardum/mcp` 0.3.0 and `@vardum/shared` 0.3.0.
- Frozen snapshots remain schema 2; folder upload/import needs matching backend capabilities.
- See [release notes and upgrade order](../client-release-0.7.md).
