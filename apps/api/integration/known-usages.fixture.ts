import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { VardEditorDefinitionV2, VardManifest } from "@vardum/shared";
import type { Evidence, Source, StoredBinding } from "../src/known-usage-model.js";
import type { Pool } from "pg";
import type { buildApp } from "../src/app.js";

// Only call with the disposable integration cluster, never a configured DB.
export async function seedKnownUsageFixture(
  app: Awaited<ReturnType<typeof buildApp>>,
  admin: Pool,
) {
  const query = (text: string, values: unknown[] = []) =>
    admin.query(text, values);
  await query(
    "INSERT INTO organization(id,name,slug,created_at) VALUES ('usage-org','Usage fixture','usage-fixture',now()),('other-org','Other fixture','other-fixture',now())",
  );
  await query(
    "INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES ('usage-ws','usage-org','Usage fixture','usage-fixture','fixture','fixture'),('other-ws','other-org','Other fixture','other-fixture','fixture','fixture')",
  );
  const cookies: Record<string, string> = {},
    users: Record<string, string> = {};
  for (const role of ["owner", "viewer", "outsider"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        name: `Usage ${role}`,
        email: `${role}@usage.test`,
        password: "disposable-password-123",
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    users[role] = response.json().user.id;
    cookies[role] = response.cookies
      .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
      .join("; ");
    await query(
      "INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ($1,$2,$3,$4,now())",
      [
        randomUUID(),
        role === "outsider" ? "other-org" : "usage-org",
        users[role],
        role === "viewer" ? "viewer" : "owner",
      ],
    );
  }
  const insertAsset = async (
    key: string,
    workspaceId = "usage-ws",
    ready = true,
  ) => {
    const id = randomUUID(),
      versionId = randomUUID();
    await query(
      "INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) VALUES ($1,$2,$3,$3,true,'fixture','fixture')",
      [id, workspaceId, key],
    );
    if (ready) {
      await query(
        "INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,created_by,updated_by) VALUES ($1::uuid,$2,$3,1,'ready',$1::text,$4,'image/png',4,$5,'fixture','fixture')",
        [versionId, workspaceId, id, key, "a".repeat(64)],
      );
      await query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [
        versionId,
        id,
      ]);
    }
    return { id, versionId };
  };
  const logo = await insertAsset("logo.png"),
    folder = await insertAsset("folder/banner.png"),
    foreign = await insertAsset("foreign.png", "other-ws");
  const empty = await insertAsset("unready.png", "usage-ws", false);
  const vardId = randomUUID(),
    foreignVardId = randomUUID();
  await query(
    "INSERT INTO vard(id,workspace_id,name,is_public,folder_rules,created_by,updated_by) VALUES ($1,'usage-ws','Brand outputs',true,$2,'fixture','fixture'),($3,'other-ws','Foreign outputs',true,'[]','fixture','fixture')",
    [
      vardId,
      JSON.stringify([{ sourcePrefix: "folder/", outputPrefix: "images/" }]),
      foreignVardId,
    ],
  );
  await query(
    "INSERT INTO vard_item(workspace_id,vard_id,asset_id,output_path,transformation,created_by,updated_by) VALUES ('usage-ws',$1,$2,'images/logo.png',$5,'fixture','fixture'),('other-ws',$3,$4,'images/foreign.png',null,'fixture','fixture')",
    [vardId, logo.id, foreignVardId, foreign.id, JSON.stringify({ w: 64 })],
  );
  const destinationId = randomUUID();
  const bindings = [
    {
      id: randomUUID(),
      destinationId,
      mode: "manual_frozen" as const,
      target: { kind: "asset" as const, assetId: logo.id },
    },
    {
      id: randomUUID(),
      destinationId,
      mode: "opt_in_pr" as const,
      target: {
        kind: "vard_output" as const,
        vardId,
        outputPath: "images/logo.png",
        assetId: logo.id,
      },
    },
    {
      id: randomUUID(),
      destinationId,
      mode: "live_url" as const,
      target: {
        kind: "vard_output" as const,
        vardId,
        outputPath: "images/banner.png",
        assetId: folder.id,
      },
    },
  ];
  const input = {
    name: "Consumer website",
    kind: "first_party" as const,
    destinations: [
      {
        id: destinationId,
        label: "Production website",
        url: "https://private-destination.usage.test/page",
      },
    ],
    bindings,
  };
  return {
    cookies,
    users,
    logo,
    folder,
    foreign,
    empty,
    vardId,
    foreignVardId,
    input,
    insertAsset,
  };
}

type FolderUsageBinding = StoredBinding & {
  current: { resolved: boolean; reason: string | null; source: Source | null; scopeToken: string };
  latestEvidence: Evidence | null;
  status: string;
};
type FolderUsageConsumer = { id: string; revision: number; bindings: FolderUsageBinding[] };

/** HTTP acceptance inside private-delivery's existing disposable app/PG cluster. */
export async function checkKnownUsageFolderUses(t: TestContext, fixture: { app: FastifyInstance; admin: Pool }) {
  const { app, admin } = fixture;
  const suffix = randomUUID(), workspaceId = `folder-usage-${suffix}`, organizationId = `folder-usage-org-${suffix}`;
  const prefix = `known-folder-${suffix}/`, outputPath = "images/logo.svg";
  const sourceId = randomUUID(), version1 = randomUUID(), version2 = randomUUID(), incompatibleVersion = randomUUID();
  const sourceKey = `${prefix}canonical/source.svg`, useKey = `${prefix}members/logo.svg`;
  const userIds: string[] = [], useIds: string[] = [];
  let vardId: string | undefined;
  function ok<T>(response: Awaited<ReturnType<typeof app.inject>>, status = 200): T {
    assert.equal(response.statusCode, status, response.body);
    return status === 204 ? undefined as T : response.json<T>();
  }
  t.after(async () => {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('vardum.vard_definition_schema','3',true)");
      await client.query("DELETE FROM known_usage WHERE workspace_id=$1", [workspaceId]);
      if (vardId) await client.query("DELETE FROM vard WHERE workspace_id=$1 AND id=$2", [workspaceId, vardId]);
      await client.query("DELETE FROM asset_use WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [workspaceId, useIds]);
      await client.query("DELETE FROM asset WHERE workspace_id=$1 AND id=$2", [workspaceId, sourceId]);
      await client.query("DELETE FROM workspace WHERE id=$1", [workspaceId]);
      await client.query("DELETE FROM organization WHERE id=$1", [organizationId]);
      await client.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [userIds]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM known_usage_check WHERE workspace_id=$1", [workspaceId])).rows[0].n, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM vard_item WHERE workspace_id=$1", [workspaceId])).rows[0].n, 0);
  });
  async function signup(role: string) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-up/email",
      payload: { name: `Folder usage ${role}`, email: `${role}-${suffix}@folder-usage.test`, password: "disposable-folder-usage-password" } });
    const user = ok<{ user: { id: string } }>(response).user; userIds.push(user.id);
    return { id: user.id, cookie: response.cookies.map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ") };
  }
  const owner = await signup("owner"), outsider = await signup("outsider");
  const headers = { cookie: owner.cookie };
  await admin.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Folder usage fixture',$1,now())", [organizationId]);
  await admin.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), organizationId, owner.id]);
  await admin.query("INSERT INTO workspace(id,organization_id,name,slug,created_by,updated_by) VALUES($1,$2,'Folder usage fixture',$1,$3,$3)", [workspaceId, organizationId, owner.id]);
  await admin.query("INSERT INTO asset(id,workspace_id,key,display_name,is_public,created_by,updated_by) VALUES($1,$2,$3,'Canonical outside-folder source',true,$4,$4)", [sourceId, workspaceId, sourceKey, owner.id]);
  async function sourceVersion(id: string, number: number, mimeType = "image/svg+xml") {
    await admin.query("INSERT INTO asset_version(id,workspace_id,asset_id,number,status,storage_key,filename,mime_type,size,checksum,width,height,created_by,updated_by) VALUES($1::uuid,$2,$3,$4,'ready',$1::text,$5,$6,64,$7,16,8,$8,$8)",
      [id, workspaceId, sourceId, number, mimeType === "image/png" ? "source.png" : "source.svg", mimeType, String(number).repeat(64), owner.id]);
    await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [id, sourceId]);
  }
  await sourceVersion(version1, 1);
  const useBase = `/api/workspaces/${workspaceId}/asset-uses`, vardBase = `/api/workspaces/${workspaceId}/vards`, usageBase = `/api/workspaces/${workspaceId}/known-usages`;
  let transformation = { w: 32, format: "svg" as const };
  async function makeUse() {
    const use = ok<{ id: string; revision: number }>(await app.inject({ method: "POST", url: useBase, headers,
      payload: { sourceAssetId: sourceId, key: useKey, displayName: "Folder generated use", transformation } }), 201);
    useIds.push(use.id); return use;
  }
  let use = await makeUse();
  vardId = ok<{ id: string }>(await app.inject({ method: "POST", url: vardBase, headers, payload: { name: "Folder usage outputs", isPublic: true } }), 201).id;
  const editor = async () => ok<VardEditorDefinitionV2>(await app.inject({ url: `${vardBase}/${vardId}/editor?definitionSchema=2`, headers }));
  const initial = await editor();
  const enabled = ok<VardEditorDefinitionV2>(await app.inject({ method: "PATCH", url: `${vardBase}/${vardId}/editor`, headers,
    payload: { definitionSchema: 2, expectedRevision: initial.revision, folderRules: [{ sourcePrefix: `${prefix}members/`, outputPrefix: "images/", includeUses: true }] } }));
  assert.equal(enabled.storedDefinitionSchema, 3); assert.deepEqual(enabled.items, []);
  const literalRevision = enabled.revision;
  const manifest = async () => ok<VardManifest>(await app.inject({ url: `${vardBase}/${vardId}/manifest`, headers }));
  const generated = (await manifest()).items;
  assert.equal(generated.length, 1, "use key matches while the canonical source is outside the selected prefix");
  const firstId = `folder:use:${createHash("sha256").update(JSON.stringify([use.id, outputPath])).digest("hex")}`;
  assert.equal(generated[0]!.id, firstId); assert.equal(generated[0]!.assetId, sourceId);
  assert.equal(generated[0]!.key, sourceKey); assert.equal(generated[0]!.outputPath, outputPath);
  assert.equal(generated[0]!.writable, false); assert.equal(generated[0]!.versionId, version1);
  const destinationId = randomUUID(), bindingId = randomUUID(), liveBindingId = randomUUID();
  const target = { kind: "vard_output", vardId, outputPath, assetId: sourceId };
  let consumer = ok<FolderUsageConsumer>(await app.inject({ method: "POST", url: usageBase, headers, payload: {
    name: "Private folder-use consumer", kind: "first_party",
    destinations: [{ id: destinationId, label: "Private declared destination", url: "https://private-folder-usage.test/consumer" }],
    bindings: [{ id: bindingId, destinationId, mode: "manual_frozen", target }, { id: liveBindingId, destinationId, mode: "live_url", target }],
  } }), 201);
  const binding = (row = consumer) => { const value = row.bindings.find(item => item.id === bindingId); assert.ok(value); return value; };
  const get = async () => ok<FolderUsageConsumer>(await app.inject({ url: `${usageBase}/${consumer.id}`, headers }));
  const report = (row: FolderUsageConsumer, versionId: string, expectedScopeToken = binding(row).current.scopeToken) => app.inject({
    method: "POST", url: `${usageBase}/${row.id}/bindings/${bindingId}/checks`, headers,
    payload: { expectedRevision: row.revision, expectedScopeToken, checkedAt: "2026-01-02T03:04:05Z", reportedVersionId: versionId, note: "Explicit disposable manual report; no external adoption check." },
  });
  const counts = async () => ({
    checks: (await admin.query("SELECT count(*)::int AS n FROM known_usage_check WHERE workspace_id=$1", [workspaceId])).rows[0].n as number,
    audits: (await admin.query("SELECT count(*)::int AS n FROM audit_event WHERE workspace_id=$1 AND action='known_usage.check_reported'", [workspaceId])).rows[0].n as number,
  });
  assert.ok(consumer.bindings.every(item => item.status === "unknown" && item.latestEvidence === null));
  assert.equal(binding().current.source!.assetId, sourceId);
  consumer = ok<FolderUsageConsumer>(await report(consumer, version1));
  assert.equal(binding().status, "recorded_match");
  const originalEvidence = binding().latestEvidence!;
  const configuration = JSON.parse(originalEvidence.scope.outputConfiguration) as string[];
  assert.deepEqual(configuration.slice(0, 2), ["use", use.id]); assert.match(configuration[2]!, /w=32/); assert.match(configuration[2]!, /format=svg/);
  assert.equal(originalEvidence.scope.mode, "manual_frozen"); assert.equal(originalEvidence.source.assetId, sourceId);
  assert.equal(consumer.bindings.find(item => item.id === liveBindingId)!.status, "unknown", "live mode never implies a manual check");

  const beforeRecipe = consumer, oldScope = binding().current.scopeToken, beforeRejectedReport = await counts();
  transformation = { w: 64, format: "svg" };
  use = { ...use, ...ok<{ revision: number }>(await app.inject({ method: "PATCH", url: `${useBase}/${use.id}`, headers,
    payload: { expectedRevision: use.revision, displayName: "Folder generated use", transformation } })) };
  consumer = await get();
  assert.equal(binding().status, "scope_changed"); assert.notEqual(binding().current.scopeToken, oldScope);
  assert.equal(binding().current.source!.versionId, version1); assert.deepEqual(binding().latestEvidence, originalEvidence);
  assert.equal((await manifest()).items[0]!.id, firstId);
  const staleRecipeReport = await report(beforeRecipe, version1);
  assert.equal(staleRecipeReport.statusCode, 409); assert.match(staleRecipeReport.body, /scope changed/i);
  assert.deepEqual(await counts(), beforeRejectedReport, "stale scope reports never insert evidence or audit");
  consumer = ok<FolderUsageConsumer>(await report(consumer, version1));
  assert.equal(binding().status, "recorded_match");
  const recipeEvidence = binding().latestEvidence!, recipeScope = binding().current.scopeToken;

  await sourceVersion(version2, 2);
  consumer = await get();
  assert.equal(binding().status, "source_changed"); assert.deepEqual(binding().latestEvidence, recipeEvidence);
  assert.equal(binding().current.scopeToken, recipeScope, "source version changes do not change configured scope");
  assert.equal(binding().current.source!.versionId, version2); assert.equal((await manifest()).items[0]!.id, firstId);
  consumer = ok<FolderUsageConsumer>(await report(consumer, version1));
  assert.equal(binding().status, "source_changed", "a historical manual report does not assert current adoption");
  assert.equal(binding().latestEvidence!.source.versionId, version1);
  consumer = ok<FolderUsageConsumer>(await report(consumer, version2));
  assert.equal(binding().status, "recorded_match");
  const beforeReplacement = binding().current, lastOldUseEvidence = binding().latestEvidence!;

  ok(await app.inject({ method: "DELETE", url: `${useBase}/${use.id}?expectedRevision=${use.revision}`, headers }), 204);
  consumer = await get();
  assert.equal(binding().status, "unresolved"); assert.equal(binding().current.reason, "output_missing");
  assert.deepEqual(binding().latestEvidence, lastOldUseEvidence);
  const oldUseId = use.id; use = await makeUse(); assert.notEqual(use.id, oldUseId);
  consumer = await get();
  assert.equal(binding().status, "scope_changed");
  assert.deepEqual(binding().current.source, beforeReplacement.source, "same canonical source/version/recipe must not hide a new use identity");
  assert.notEqual(binding().current.scopeToken, beforeReplacement.scopeToken);
  assert.deepEqual(binding().latestEvidence, lastOldUseEvidence);
  const replacementItem = (await manifest()).items[0]!;
  assert.equal(replacementItem.assetId, sourceId); assert.equal(replacementItem.key, sourceKey);
  assert.equal(replacementItem.outputPath, outputPath); assert.notEqual(replacementItem.id, firstId);
  assert.equal(replacementItem.id, `folder:use:${createHash("sha256").update(JSON.stringify([use.id, outputPath])).digest("hex")}`);
  const beforeIdentityReject = await counts();
  const staleIdentityReport = await report(consumer, version2, beforeReplacement.scopeToken);
  assert.equal(staleIdentityReport.statusCode, 409); assert.match(staleIdentityReport.body, /scope changed/i);
  assert.deepEqual(await counts(), beforeIdentityReject);
  consumer = ok<FolderUsageConsumer>(await report(consumer, version2));
  const replacementEvidence = binding().latestEvidence!;
  assert.deepEqual((JSON.parse(replacementEvidence.scope.outputConfiguration) as string[]).slice(0, 2), ["use", use.id]);

  await sourceVersion(incompatibleVersion, 3, "image/png");
  consumer = await get();
  assert.equal(binding().status, "unresolved"); assert.equal(binding().current.reason, "source_unavailable");
  assert.equal(binding().current.source, null); assert.deepEqual(binding().latestEvidence, replacementEvidence);
  const unavailable = (await manifest()).items[0]!;
  assert.equal(unavailable.id, replacementItem.id); assert.equal(unavailable.outputPath, outputPath);
  assert.deepEqual([unavailable.versionId, unavailable.sourceChecksum, unavailable.fingerprint, unavailable.downloadUrl], [null, null, null, null]);
  const beforeUnavailableReport = await counts();
  const unavailableReport = await report(consumer, version2);
  assert.equal(unavailableReport.statusCode, 409); assert.match(unavailableReport.body, /unresolved/i); assert.deepEqual(await counts(), beforeUnavailableReport);
  await admin.query("UPDATE asset SET current_version_id=$1 WHERE id=$2", [version2, sourceId]);
  consumer = await get(); assert.equal(binding().status, "recorded_match");
  ok(await app.inject({ method: "DELETE", url: `${useBase}/${use.id}?expectedRevision=${use.revision}`, headers }), 204);
  consumer = await get();
  assert.equal(binding().status, "unresolved"); assert.equal(binding().current.reason, "output_missing");
  assert.deepEqual(binding().latestEvidence, replacementEvidence); assert.equal((await editor()).revision, literalRevision);

  const history = await app.inject({ url: `${usageBase}/${consumer.id}/bindings/${bindingId}/checks`, headers });
  const checks = ok<{ checks: Evidence[] }>(history).checks;
  assert.deepEqual(checks.find(item => item.id === originalEvidence.id), originalEvidence);
  assert.deepEqual(checks.find(item => item.id === replacementEvidence.id), replacementEvidence);
  assert.equal(history.headers["cache-control"], "private, no-store");
  assert.equal((await app.inject({ url: `${usageBase}/${consumer.id}` })).statusCode, 401);
  assert.equal((await app.inject({ url: `${usageBase}/${consumer.id}`, headers: { cookie: outsider.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ url: `${usageBase}/${consumer.id}/bindings/${bindingId}/checks`, headers: { cookie: outsider.cookie } })).statusCode, 403);
  const publicManifest = await app.inject({ url: `/v/${vardId}` });
  ok(publicManifest); assert.doesNotMatch(publicManifest.body, /knownUsage|known_usage|Private folder-use consumer|private-folder-usage|declared destination/);
}
