import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { VardDefinition, VardItem, VardManifest } from "@vardum/shared";
import {
  getVard,
  getVardManifest,
  updateVard,
  replaceVardItems,
} from "./asset-api.js";
import {
  applyVardMetadata,
  generatedOutputs,
  manualDraftItems,
  refreshVardPreview,
} from "./vard-editor-state.js";

const manual: VardItem = {
  id: "manual-id",
  assetId: "asset",
  key: "logo.svg",
  outputPath: "logo.svg",
  versionId: "version",
  pinned: true,
  transformation: null,
  writable: false,
  sourceChecksum: "checksum",
  mimeType: "image/svg+xml",
  size: 12,
  fingerprint: "fingerprint",
  downloadUrl: "https://example.test/logo.svg",
};
const definition: VardDefinition = {
  schema: 1,
  id: "vard",
  workspaceId: "workspace",
  name: "Website",
  isPublic: true,
  updatedAt: "2026-01-01T00:00:00Z",
  items: [manual],
  folderRules: [{ sourcePrefix: "brand/", outputPrefix: "assets/brand/" }],
};

test("Vard editor drafts use only configuration; metadata preserves manual IDs, pins, transforms and writable controls", () => {
  const transformed = {
    ...manual,
    id: "transformed",
    pinned: false,
    transformation: { w: 32 },
  };
  const writable = { ...manual, id: "writable", pinned: false, writable: true };
  const config = { ...definition, items: [manual, transformed, writable] };
  const generated = {
    ...manual,
    id: "folder:generated",
    pinned: false,
    writable: false,
    outputPath: "assets/brand/logo.svg",
  };
  const preview = { ...definition, items: [...config.items, generated] };
  assert.deepEqual(generatedOutputs(preview), [generated]);
  const drafts = manualDraftItems(config);
  assert.deepEqual(
    drafts.map(({ id }) => id),
    ["manual-id", "transformed", "writable"],
  );
  assert.equal(drafts[0]?.versionId, "version");
  assert.deepEqual(drafts[1]?.transformation, { w: 32 });
  assert.equal(drafts[1]?.versionId, null);
  assert.equal(drafts[2]?.writable, true);
  const saved = applyVardMetadata(config, { ...definition, folderRules: [] });
  assert.equal(saved.items, config.items);
  assert.equal(saved.isPublic, true);
  assert.deepEqual(saved.folderRules, []);
});

test("Generated output classification ignores stale manual IDs from an independent preview", () => {
  const generated = { ...manual, id: "folder:generated", pinned: false };
  const stalePreview = { ...definition, items: [manual, generated] };
  assert.deepEqual(generatedOutputs(stalePreview), [generated]);
});

test("Post-save preview refresh replaces an initial in-flight manifest instead of reusing stale results", async (t) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  t.after(() => client.clear());
  const queryKey = ["vard-preview", definition.workspaceId, definition.id];
  const saved = { ...definition, items: [{ ...manual, id: "manual-new" }] };
  let release!: (value: VardManifest) => void;
  const initial = new Promise<VardManifest>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: () => (++calls === 1 ? initial : Promise.resolve(saved)),
  });
  const unsubscribe = observer.subscribe(() => {});
  t.after(unsubscribe);
  assert.equal(client.getQueryState(queryKey)?.fetchStatus, "fetching");
  assert.equal(client.getQueryData(queryKey), undefined);
  client.setQueryData(["vard", definition.workspaceId, definition.id], saved);
  const refreshing = refreshVardPreview(
    client,
    definition.workspaceId,
    definition.id,
  );
  release(definition);
  await refreshing;
  assert.equal(
    calls,
    2,
    "A successful save must fetch a new preview even if its first request is unfinished",
  );
  assert.deepEqual(client.getQueryData(queryKey), saved);
  assert.deepEqual(
    client.getQueryData(["vard", definition.workspaceId, definition.id]),
    saved,
  );
});

test("Vard configuration and rules remain repairable when the separate resolved preview fails", async (t) => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  let saved = definition;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method, body });
      if (url.endsWith("/manifest"))
        return new Response(
          JSON.stringify({
            statusCode: 409,
            error: "Conflict",
            message:
              "Vard output paths collide; repair manual items or folder rules",
          }),
          { status: 409 },
        );
      if (init?.method === "PATCH") {
        assert.deepEqual(body, { folderRules: [] });
        saved = { ...saved, folderRules: [] };
      }
      return new Response(JSON.stringify(saved));
    },
  );
  const config = await getVard("workspace", "vard");
  await assert.rejects(
    getVardManifest("workspace", "vard"),
    /output paths collide; repair/,
  );
  assert.deepEqual(
    manualDraftItems(config).map(({ id }) => id),
    ["manual-id"],
  );
  assert.deepEqual(config.folderRules, definition.folderRules);
  const metadata = await updateVard("workspace", "vard", { folderRules: [] });
  const repaired = applyVardMetadata(config, metadata);
  assert.equal(repaired.items, config.items);
  assert.equal(repaired.isPublic, true);
  assert.deepEqual(repaired.folderRules, []);
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "/api/workspaces/workspace/vards/vard",
      "/api/workspaces/workspace/vards/vard/manifest",
      "/api/workspaces/workspace/vards/vard",
    ],
  );
});

test("Vard API forwards mutation errors and item writes contain only manual drafts, not rules or expanded rows", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH")
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
        });
      const body = JSON.parse(init.body as string);
      assert.deepEqual(Object.keys(body), ["items"]);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].assetId, manual.assetId);
      assert.equal(body.items[0].versionId, manual.versionId);
      return new Response(JSON.stringify(definition));
    },
  );
  await assert.rejects(
    updateVard("workspace", "vard", { folderRules: [] }),
    /Forbidden/,
  );
  assert.deepEqual(definition.folderRules, [
    { sourcePrefix: "brand/", outputPrefix: "assets/brand/" },
  ]);
  const saved = await replaceVardItems(
    "workspace",
    "vard",
    manualDraftItems(definition).map(
      ({ assetId, versionId, outputPath, transformation, writable }) => ({
        assetId,
        versionId,
        outputPath,
        transformation,
        writable,
      }),
    ),
  );
  assert.deepEqual(saved, definition);
});
