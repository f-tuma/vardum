import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  assetPageSql,
  assetPaginationQuery,
  decodeAssetCursor,
  encodeAssetCursor,
  literalAssetSearch,
  maximumAssetCursorLength,
  normalizedAssetSearch,
  type AssetPagePosition,
  type AssetPageScope,
} from "./asset-pagination.js";

const secret = "unit-test-browser-cursor-secret-at-least-32-characters";
const scope: AssetPageScope = {
  workspaceId: "workspace",
  prefix: "brand/",
  search: "",
  limit: 50,
};
const folder: AssetPagePosition = {
  kindRank: 0,
  path: "brand/logos/",
  stableIdentity: "brand/logos/",
};
const item: AssetPagePosition = {
  kindRank: 1,
  path: "brand/logo.png",
  stableIdentity: randomUUID(),
};

test("asset cursor preserves folder and asset tuples and is reusable in its scope", () => {
  for (const position of [folder, item]) {
    const cursor = encodeAssetCursor(scope, position, secret);
    assert.deepEqual(decodeAssetCursor(cursor, scope, secret), position);
    assert.deepEqual(decodeAssetCursor(cursor, scope, secret), position);
    assert.equal(cursor.length < maximumAssetCursorLength, true);
  }
  assert.equal(decodeAssetCursor(undefined, scope, secret), null);
  // Hydrated values must never be accidentally embedded in a cursor.
  const candidate = { ...item, displayName: "Private display name" };
  const cursor = encodeAssetCursor(scope, candidate, secret);
  assert.deepEqual(decodeAssetCursor(cursor, scope, secret), item);
  assert.doesNotMatch(
    Buffer.from(cursor.split(".")[0]!, "base64url").toString(),
    /Private/,
  );
});

test("asset cursor rejects altered signatures, malformed input, and other scopes", () => {
  const cursor = encodeAssetCursor(scope, item, secret);
  for (const invalid of [
    "",
    "not-a-cursor",
    ".",
    `${cursor}.extra`,
    cursor.replace(/^./, cursor[0] === "A" ? "B" : "A"),
    cursor.slice(0, -2) + "AA",
    "A".repeat(maximumAssetCursorLength + 1),
  ])
    assert.equal(decodeAssetCursor(invalid, scope, secret), "invalid");
  assert.equal(
    decodeAssetCursor(cursor, scope, `${secret}-different`),
    "invalid",
  );
  for (const changed of [
    { workspaceId: "other" },
    { prefix: "brand/logos/" },
    { search: "logo" },
    { limit: 51 },
  ]) {
    assert.equal(
      decodeAssetCursor(cursor, { ...scope, ...changed }, secret),
      "invalid",
    );
  }
});

test("asset cursor binds normalized search and validates signed payload fields", () => {
  const searched = { ...scope, search: "  logo  " };
  const cursor = encodeAssetCursor(searched, item, secret);
  assert.deepEqual(
    decodeAssetCursor(cursor, { ...scope, search: "logo" }, secret),
    item,
  );
  const payload = JSON.parse(
    Buffer.from(cursor.split(".")[0]!, "base64url").toString(),
  );
  for (const changed of [
    { version: 2 },
    { kindRank: 2 },
    { path: "elsewhere/logo" },
    { stableIdentity: "invalid-id" },
    { unexpected: true },
    { kindRank: 0, path: "brand/folder/", stableIdentity: "brand/other/" },
  ]) {
    const encoded = Buffer.from(
      JSON.stringify({ ...payload, ...changed }),
    ).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update("vardum:asset-browser:cursor:v1\0")
      .update(encoded)
      .digest("base64url");
    assert.equal(
      decodeAssetCursor(`${encoded}.${signature}`, searched, secret),
      "invalid",
    );
  }
});

test("browser cursor query is bounded and search patterns match literals", () => {
  const query = z.object(assetPaginationQuery);
  assert.equal(query.safeParse({ pagination: "offset" }).success, false);
  assert.equal(
    query.safeParse({ cursor: "A".repeat(maximumAssetCursorLength + 1) })
      .success,
    false,
  );
  assert.equal(normalizedAssetSearch("   "), "");
  assert.equal(normalizedAssetSearch("  logo  "), "logo");
  assert.equal(literalAssetSearch("100%_\\done"), "%100\\%\\_\\\\done%");
});

test("asset phase omits folder discovery and every keyset order uses C collation", () => {
  const dialect = new PgDialect();
  const first = dialect.sqlToQuery(assetPageSql(scope, null));
  assert.match(first.sql, /UNION\s+SELECT/);
  assert.match(first.sql, /candidate_page AS MATERIALIZED/);
  assert.ok(first.params.includes(51));
  const next = dialect.sqlToQuery(assetPageSql(scope, item));
  assert.doesNotMatch(next.sql, /asset_folder|folder_sources|folders AS/);
  assert.match(next.sql, /path COLLATE "C", stable_identity COLLATE "C"\) >/);
  assert.doesNotMatch(next.sql, /OFFSET/);
  assert.match(next.sql, /FROM consumed_page p\s+JOIN "asset" a/);
  assert.match(next.sql, /WHERE v.asset_id = a.id AND v.workspace_id =/);
  const searched = dialect.sqlToQuery(
    assetPageSql({ ...scope, search: "%" }, null),
  );
  assert.doesNotMatch(searched.sql, /ESCAPE ''/);
  assert.ok(searched.params.includes(literalAssetSearch("%")));
});
