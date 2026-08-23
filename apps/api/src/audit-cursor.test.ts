import assert from "node:assert/strict";
import test from "node:test";
import {
  auditCursor,
  decodeAuditCursor,
  encodeAuditCursor,
} from "./asset-routes.js";

test("audit cursors round-trip and reject junk", () => {
  const event = {
    createdAt: new Date("2026-08-23T01:02:03.456Z"),
    id: "1b0f4b2c-9d3e-4a51-8b77-2c6f0d5e1a99",
  };
  const cursor = encodeAuditCursor(event);
  assert.equal(auditCursor.safeParse(cursor).success, true);

  const decoded = decodeAuditCursor(cursor);
  assert.notEqual(decoded, "invalid");
  assert.deepEqual(decoded, { after: event.createdAt, id: event.id });

  assert.equal(decodeAuditCursor(undefined), null);
  assert.equal(
    decodeAuditCursor(`not-a-date|${event.id}`),
    "invalid",
    "an unparseable timestamp must not silently page from epoch",
  );
  for (const junk of ["", "|", event.id, `${event.createdAt.toISOString()}|x`])
    assert.equal(auditCursor.safeParse(junk).success, false, junk);
});
