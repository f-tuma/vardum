// Bind-mounted at /app/runtime-tls-probe.mjs: deployed modules and package
// resolution come from /app, never the host checkout's node_modules.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = process.env.TLS_PROBE_PATH;
const certificateCodes = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]);
function refusal(error) {
  // AWS keeps TLS codes; SMTP sometimes replaces them with ESOCKET; execFile
  // wraps the pg-boss CLI stderr. Retain only a precise certificate category.
  const seen = new Set();
  const codes = new Set();
  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (certificateCodes.has(value.code)) codes.add(value.code);
    for (const text of [value.message, value.stderr]) {
      for (const code of certificateCodes) if (typeof text === "string" && text.includes(code)) codes.add(code);
      if (/certificate has expired/i.test(text ?? "")) codes.add("CERT_HAS_EXPIRED");
      if (/Hostname\/IP does not match certificate|not in the cert.s altnames/i.test(text ?? "")) codes.add("ERR_TLS_CERT_ALTNAME_INVALID");
      if (/unable to verify the first certificate/i.test(text ?? "")) codes.add("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
      if (/unable to get local issuer certificate/i.test(text ?? "")) codes.add("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    }
    visit(value.cause);
    for (const child of value.errors ?? []) visit(child);
  }
  visit(error);
  return [...codes];
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const bossEntry = import.meta.resolve("pg-boss");
const bossDb = new URL("./db.js", bossEntry);
const runtime = {
  node: process.versions.node, openssl: process.versions.openssl,
  process: { uid: process.getuid(), ...Object.fromEntries(["CapEff", "CapBnd", "NoNewPrivs"].map(name => [name, readFileSync("/proc/self/status", "utf8").match(new RegExp(`^${name}:\\s*(\\w+)$`, "m"))?.[1]])) },
  pgBoss: { version: JSON.parse(readFileSync(new URL("../package.json", bossEntry), "utf8")).version, dbModule: fileURLToPath(bossDb), dbSha256: digest(readFileSync(bossDb)) },
  modules: Object.fromEntries(["storage.js", "mail.js", "db/index.js", "queue.js", "queue-migrate.js", "migrate.js", "server.js", "worker.js"].map(name => [name, digest(readFileSync(new URL(`./dist/${name}`, import.meta.url)))])),
};
assert.equal(runtime.process.uid, 65532);
for (const field of ["CapEff", "CapBnd"]) assert.equal(BigInt("0x" + runtime.process[field]), 0n);
assert.equal(runtime.process.NoNewPrivs, "1");
async function encrypted(pool) {
  const { rows } = await pool.query("SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ssl, true);
  return rows[0];
}
async function sessions(pool, name) {
  const { rows } = await pool.query("SELECT a.pid, s.ssl, s.version, s.cipher, a.query FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.application_name=$1", [name]);
  assert.ok(rows.length >= 2, "Dedicated queue pool and LISTEN sessions required");
  assert.ok(rows.every(row => row.ssl), "Every queue connection must be encrypted");
  const listeners = rows.filter(row => /^LISTEN /i.test(row.query));
  assert.ok(listeners.length >= 1, "Dedicated LISTEN must be active");
  return { count: rows.length, listeners: listeners.length, allEncrypted: true, protocols: [...new Set(rows.map(row => row.version))] };
}
async function run() {
  if (path === "storage") {
    const { putDerivedObject, getObject, readBoundedObject, deleteObjects, storage } = await import("./dist/storage.js");
    try {
      const payload = Buffer.from("synthetic-runtime-tls-payload\n");
      await putDerivedObject("tls-probe", payload, "text/plain");
      const actual = await readBoundedObject(await getObject("tls-probe"), 128);
      assert.deepEqual(actual, payload);
      await deleteObjects(["tls-probe"]);
      let deleted = false;
      try { await getObject("tls-probe"); } catch (error) { deleted = error.$metadata?.httpStatusCode === 404; }
      assert.ok(deleted, "Delete must remove the synthetic object");
      return { payloadSha256: digest(actual), deleted };
    } finally { storage.destroy(); }
  }
  if (path === "smtp-implicit" || path === "smtp-starttls") {
    const { sendActionEmail } = await import("./dist/mail.js");
    await sendActionEmail({ to: "recipient@synthetic.invalid", subject: "Synthetic TLS probe", intro: "Fixture", action: "Fixture", url: "https://synthetic.invalid/action" });
    return { sent: true };
  }
  if (path === "db") {
    const { pool, closeDatabase } = await import("./dist/db/index.js");
    try {
      assert.deepEqual((await pool.query("SELECT value FROM tls_sentinel")).rows, [{ value: "untouched" }]);
      return { encryption: await encrypted(pool) };
    } finally { await closeDatabase(); }
  }
  if (path === "queue") {
    const { boss, startQueue, stopQueue, assetDeleteQueue } = await import("./dist/queue.js");
    const warnings = [];
    boss.on("warning", warning => { warnings.push(warning.data?.type ?? "warning"); });
    const { pool, closeDatabase } = await import("./dist/db/index.js");
    try {
      await startQueue();
      const id = await boss.send(assetDeleteQueue, { versionIds: [], storageKeys: [] });
      assert.ok(id);
      assert.deepEqual(warnings, [], "Queue startup must not fall back to polling");
      return { sent: true, warnings, encryption: await sessions(pool, process.env.TLS_APPLICATION_NAME) };
    } finally { await stopQueue(); await closeDatabase(); }
  }
  if (path === "listener") {
    const { default: Db } = await import(new URL("./db.js", import.meta.resolve("pg-boss")));
    const db = new Db({ connectionString: process.env.DATABASE_URL });
    db.on("error", () => {});
    let listener;
    try {
      await db.open();
      // Start the installed dedicated listener before any pool query, so a
      // pool rejection cannot hide a listener certificate regression.
      let notified = false;
      listener = await db.listen("runtime_tls", value => { notified = value === "synthetic"; }, () => {});
      await db.executeSql("NOTIFY runtime_tls, 'synthetic'");
      for (let n = 0; n < 20 && !notified; n++) await delay(50);
      assert.ok(notified, "LISTEN must receive the synthetic notification");
      return { notified, encryption: await sessions(db.pool, process.env.TLS_APPLICATION_NAME) };
    } finally { await listener?.close(); if (db.opened) await db.close(); }
  }
  if (path === "queue-migrate") {
    const { migrateQueue } = await import("./dist/queue-migrate.js");
    await migrateQueue(process.env.DATABASE_URL);
    return { migrated: true };
  }
  if (path === "bucket") {
    const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
    try { await client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET })); return { created: true }; }
    finally { client.destroy(); }
  }
  if (path === "worker-job") {
    const { putDerivedObject, getObject, storage } = await import("./dist/storage.js");
    const { boss, startQueue, stopQueue, assetDeleteQueue } = await import("./dist/queue.js");
    try {
      await putDerivedObject("worker-tls-object", Buffer.from("synthetic worker deletion"), "text/plain");
      await startQueue();
      const id = await boss.send(assetDeleteQueue, { versionIds: [], storageKeys: ["worker-tls-object"] });
      assert.ok(id);
      for (let n = 0; n < 80; n++) {
        try { const object = await getObject("worker-tls-object"); object.Body?.destroy(); }
        catch (error) { if (error.$metadata?.httpStatusCode === 404) return { sent: true, objectDeleted: true }; throw error; }
        await delay(250);
      }
      throw new Error("Worker did not delete synthetic object");
    } finally { await stopQueue(); storage.destroy(); }
  }
  throw new Error("Unknown probe path");
}
try {
  const result = await run();
  console.log(JSON.stringify({ runtimeTls: true, path, status: "accepted", runtime, ...result }));
} catch (error) {
  console.log(JSON.stringify({ runtimeTls: true, path, status: "refused", codes: refusal(error), runtime }));
  process.exitCode = 1;
}
