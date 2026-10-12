import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
