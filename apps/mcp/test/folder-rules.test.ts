import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { VardDefinition } from "@vardum/shared";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, "text");
  return result.content[0].text as string;
}

test("MCP stdio folder configuration, resolved preview, omission, validation and API error forwarding", {
  timeout: 15_000,
}, async (t) => {
  const rules = [{ sourcePrefix: "brand/", outputPrefix: "assets/brand/" }];
  const manualId = "11111111-1111-4111-8111-111111111111";
  let definition: VardDefinition = {
    schema: 1,
    id: "vard",
    workspaceId: "workspace",
    name: "Website",
    isPublic: true,
    updatedAt: "2026-01-01T00:00:00Z",
    folderRules: rules,
    items: [
      {
        id: manualId,
        assetId: "asset",
        key: "logo.svg",
        outputPath: "logo.svg",
        writable: true,
        pinned: false,
        pinnedVersionId: null,
        transformation: null,
        versionId: "version",
        sourceChecksum: "checksum",
        mimeType: "image/svg+xml",
        size: 12,
        fingerprint: "fingerprint",
        downloadUrl: "https://example.test/logo.svg",
      },
    ],
  };
  const revision = () => `v1:${createHash("sha256").update(JSON.stringify([
    definition.name, definition.isPublic, definition.folderRules, definition.items,
  ])).digest("hex")}`;
  definition.revision = revision();
  let previewConflict = true;
  const calls: Array<{
    method: string;
    path: string;
    body: Record<string, unknown>;
    key?: string;
  }> = [];
  const api = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    const key = request.headers["x-api-key"] as string | undefined;
    calls.push({ method: request.method!, path, body, key });
    if (path === "/api/capabilities") {
      response.end(JSON.stringify({ vardEditRevision: 1 }));
      return;
    }
    if (path.endsWith("/manifest")) {
      if (previewConflict) {
        response.statusCode = 409;
        response.end(
          JSON.stringify({
            statusCode: 409,
            error: "Conflict",
            message:
              "Vard output paths collide; repair manual items or folder rules",
          }),
        );
      } else {
        const { folderRules: _rules, revision: _revision, ...manifest } = definition;
        response.end(
          JSON.stringify({
            ...manifest,
            items: [
              ...manifest.items,
              {
                ...manifest.items[0],
                id: "folder:generated",
                outputPath: "assets/brand/logo.svg",
                writable: false,
                pinned: false,
                transformation: null,
              },
            ],
          }),
        );
      }
    } else if (request.method === "PATCH" && path.endsWith("/editor")) {
      const { expectedRevision, ...fields } = body;
      if (key !== "fixture-editor") {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: "Forbidden" }));
      } else if (expectedRevision !== definition.revision) {
        response.statusCode = 409;
        response.end(JSON.stringify({ code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision: definition.revision }));
      } else if (
        !Object.keys(fields).length ||
        body.folderRules?.[0]?.sourcePrefix === "../"
      ) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            error: "Bad Request",
            message:
              "Folder prefix must be empty (root) or a safe slash-terminated relative directory",
          }),
        );
      } else {
        definition = { ...definition, ...fields };
        definition.revision = revision();
        response.end(JSON.stringify(definition));
      }
    } else if (
      request.method === "POST" &&
      path === "/api/workspaces/workspace/vards"
    ) {
      response.statusCode = 201;
      response.end(JSON.stringify({ ...definition, ...body }));
    } else if (
      path === "/api/workspaces/workspace/vards/vard/editor" &&
      request.method === "GET"
    ) {
      response.end(JSON.stringify(definition));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Unexpected request" }));
    }
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  for (const key of ["fixture-editor", "fixture-reader"]) {
    const client = new Client({ name: "folder-rules-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", import.meta.resolve("tsx"), entry],
        env: {
          VARDUM_SERVER: `http://127.0.0.1:${address.port}`,
          VARDUM_API_KEY: key,
        },
        stderr: "pipe",
      }),
    );
  }
  const [editor, reader] = clients as [Client, Client];
  const args = { workspaceId: "workspace", vardId: "vard" };
  const tool = (name: string, extra = {}) =>
    editor.callTool({ name, arguments: {
      ...args, ...(name === "update_vard" ? { expectedRevision: definition.revision } : {}), ...extra,
    } });
  const listed = (await editor.listTools()).tools;
  assert.ok(
    listed.find(({ name }) => name === "update_vard")?.inputSchema.properties
      ?.folderRules,
  );
  assert.match(
    JSON.stringify(await editor.readResource({ uri: "vardum://constraints" })),
    /1000/,
  );
  assert.deepEqual(JSON.parse(text(await tool("get_vard"))), definition);
  const preview = await tool("get_vard", { resolved: true });
  assert.equal(preview.isError, true);
  assert.match(text(preview), /output paths collide.*409/);
  assert.deepEqual(
    JSON.parse(text(await tool("get_vard"))).folderRules,
    rules,
    "failed preview must not block configuration inspection",
  );
  previewConflict = false;
  const resolved = JSON.parse(text(await tool("get_vard", { resolved: true })));
  assert.deepEqual(
    resolved.items.map((item: { id: string }) => item.id),
    [manualId, "folder:generated"],
  );
  assert.equal(resolved.items[1].writable, false);
  assert.equal(resolved.folderRules, undefined);
  const configAfterPreview = JSON.parse(
    text(await tool("get_vard", { resolved: false })),
  );
  assert.deepEqual(
    configAfterPreview.items.map((item: { id: string }) => item.id),
    [manualId],
  );
  assert.deepEqual(configAfterPreview.folderRules, rules);
  const beforeRename = definition.revision;
  const renamed = await tool("update_vard", { expectedRevision: beforeRename, name: "Renamed" });
  assert.notEqual(renamed.isError, true);
  assert.deepEqual(calls.at(-1)?.body, { expectedRevision: beforeRename, name: "Renamed" });
  assert.equal(definition.isPublic, true);
  assert.deepEqual(definition.folderRules, rules);
  for (const folderRules of [
    [],
    [{ sourcePrefix: "", outputPrefix: "" }],
    [{ sourcePrefix: "not-yet/", outputPrefix: "assets/" }],
    rules,
  ]) {
    const expectedRevision = definition.revision;
    const saved = await tool("update_vard", { folderRules });
    assert.notEqual(saved.isError, true);
    assert.deepEqual(calls.at(-1)?.body, { expectedRevision, folderRules });
    const config = JSON.parse(text(saved)) as VardDefinition;
    assert.deepEqual(config.folderRules, folderRules);
    assert.equal(config.items[0]?.id, manualId);
    assert.equal(config.isPublic, true);
  }
  const denied = await reader.callTool({
    name: "update_vard",
    arguments: { ...args, expectedRevision: definition.revision, folderRules: [] },
  });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /Forbidden.*403/);
  assert.deepEqual(definition.folderRules, rules);
  for (const extra of [
    {},
    { folderRules: [{ sourcePrefix: "../", outputPrefix: "" }] },
  ]) {
    const invalid = await tool("update_vard", extra);
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), /Folder prefix.*400/);
  }
  const before = calls.length;
  for (const folderRules of [
    "brand/",
    [{ sourcePrefix: 1, outputPrefix: "" }],
    [{ ...rules[0], glob: "*" }],
    Array(65).fill(rules[0]),
    [{ sourcePrefix: "x".repeat(256), outputPrefix: "" }],
  ]) {
    const invalid = await tool("update_vard", { folderRules });
    assert.equal(invalid.isError, true);
  }
  assert.equal(
    calls.length,
    before,
    "structurally invalid folder rules must not reach HTTP",
  );
  const created = await editor.callTool({
    name: "create_vard",
    arguments: { workspaceId: "workspace", name: "New", folderRules: rules },
  });
  assert.notEqual(created.isError, true);
  assert.deepEqual(calls.at(-1)?.body, { name: "New", folderRules: rules });
  await editor.callTool({
    name: "create_vard",
    arguments: { workspaceId: "workspace", name: "Empty" },
  });
  assert.deepEqual(calls.at(-1)?.body, { name: "Empty" });
  assert.ok(
    calls.every(
      ({ path, key }) =>
        (path === "/api/capabilities" || path.startsWith("/api/workspaces/workspace/vards")) &&
        key?.startsWith("fixture-"),
    ),
  );
});
