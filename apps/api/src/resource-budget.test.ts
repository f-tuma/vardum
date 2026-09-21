import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import Fastify from "fastify";
import { admissionLimit, registerAdmission } from "./resource-budget.js";
import { config, parseConfig } from "./config.js";
import { outputPixels } from "./transform-budget.js";
import { readBoundedObject } from "./storage.js";

test("capacity rejects without queuing and releases exactly once", () => {
  const gate = admissionLimit(2);
  const a = gate.acquire();
  const b = gate.acquire();
  assert.throws(() => gate.acquire(), /busy/);
  a();
  a();
  assert.equal(gate.active, 1);
  gate.acquire()();
  b();
  assert.equal(gate.active, 0);
});

test("request admission retains streaming slots and keeps health available", async () => {
  const prior = config.DELIVERY_MAX_INFLIGHT;
  config.DELIVERY_MAX_INFLIGHT = 1;
  const app = Fastify();
  registerAdmission(app);
  config.DELIVERY_MAX_INFLIGHT = prior;
  const stream = new PassThrough();
  const unblock = () => {
    if (!stream.writableEnded) stream.end("ok");
  };
  let began!: () => void;
  const started = new Promise<void>((yes) => {
    began = yes;
  });
  app.get("/w/slow", async () => {
    began();
    return stream;
  });
  app.get("/w/fast", async () => "ok");
  app.get("/health", async () => "ok");
  const first = app.inject("/w/slow");
  const running = first.then((x) => x);
  try {
    await started;
    const denied = await app.inject("/w/fast");
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.headers["retry-after"], "1");
    assert.equal(denied.headers["cache-control"], "private, no-store");
    assert.equal((await app.inject("/health")).statusCode, 200);
    unblock();
    await running;
    assert.equal((await app.inject("/w/fast")).statusCode, 200);
  } finally {
    unblock?.();
    await running;
    await app.close();
  }
});

test("delivery rate gate returns 429 and does not retain a concurrency slot", async () => {
  const old = config.DELIVERY_REQUESTS_PER_SECOND;
  config.DELIVERY_REQUESTS_PER_SECOND = 1;
  const app = Fastify();
  registerAdmission(app);
  app.get("/w/fast", async () => "ok");
  try {
    assert.equal((await app.inject("/w/fast")).statusCode, 200);
    const denied = await app.inject("/w/fast");
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.headers["retry-after"], "1");
  } finally {
    config.DELIVERY_REQUESTS_PER_SECOND = old;
    await app.close();
  }
});

test("output budget accounts for outside aspect ratio, upscaling and animation", () => {
  assert.equal(outputPixels(1000, 1, 1, { h: 4096 }), 16_777_216_000);
  assert.equal(
    outputPixels(1000, 1, 2, { w: 100, h: 100, fit: "outside" }),
    20_000_000,
  );
  assert.equal(
    outputPixels(1000, 1, 2, { w: 100, h: 100, fit: "cover" }),
    20_000,
  );
  assert.equal(outputPixels(1000, 500, 10, {}), 5_000_000);
});

test("object reads bound both declared and streamed bytes", async () => {
  const object = (chunks: Buffer[], length?: number) =>
    ({
      Body: Readable.from(chunks),
      ContentLength: length,
    }) as unknown as Parameters<typeof readBoundedObject>[0];
  await assert.rejects(
    readBoundedObject(object([Buffer.alloc(3)], 3), 2),
    /reserved/,
  );
  await assert.rejects(
    readBoundedObject(object([Buffer.alloc(2), Buffer.alloc(2)]), 3),
    /reserved/,
  );
  assert.equal(
    (await readBoundedObject(object([Buffer.from("ok")]), 2)).toString(),
    "ok",
  );
});

test("resource configuration cannot silently disable limits", () => {
  for (const key of [
    "WORKSPACE_STORAGE_MB",
    "WORKSPACE_PENDING_UPLOADS",
    "UPLOAD_PENDING_HOURS",
    "API_MAX_INFLIGHT",
    "DELIVERY_MAX_INFLIGHT",
    "DELIVERY_REQUESTS_PER_SECOND",
    "TRANSFORM_CONCURRENCY",
    "TRANSFORM_MAX_OUTPUT_PIXELS",
    "TRANSFORM_TIMEOUT_SECONDS",
  ])
    for (const value of ["0", "-1", "no", "0.1"])
      assert.throws(() => parseConfig({ NODE_ENV: "test", [key]: value }));
});
