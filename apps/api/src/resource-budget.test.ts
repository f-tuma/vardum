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

const deliveryRoutes = [
  {
    route: "/w/:workspaceSlug/*",
    plain: "/w/demo/fast",
    encoded: "/%77/demo/fast",
  },
  {
    route: "/w/:workspaceSlug/__v/:versionId/*",
    plain: "/w/demo/__v/version/fast",
    encoded: "/%77/demo/__v/version/fast",
  },
  { route: "/w/:assetKey", plain: "/w/fast", encoded: "/%77/fast" },
  {
    route: "/w/__v/:versionId/*",
    plain: "/w/__v/version/fast",
    encoded: "/%77/__v/version/fast",
  },
  {
    route: "/assets/:workspaceSlug/*",
    plain: "/assets/demo/fast",
    encoded: "/%61ssets/demo/fast",
  },
  {
    route: "/assets/:workspaceSlug/__v/:versionId/*",
    plain: "/assets/demo/__v/version/fast",
    encoded: "/%61ssets/demo/__v/version/fast",
  },
];

for (const { route, plain, encoded } of deliveryRoutes)
  for (const method of ["GET", "HEAD"] as const) {
    test(`delivery rate gate covers encoded ${method} ${route}`, async () => {
      const oldRate = config.DELIVERY_REQUESTS_PER_SECOND;
      const oldConcurrency = config.DELIVERY_MAX_INFLIGHT;
      config.DELIVERY_REQUESTS_PER_SECOND = 1;
      config.DELIVERY_MAX_INFLIGHT = 1;
      const app = Fastify();
      registerAdmission(app);
      app.get(route, async () => "ok");
      try {
        assert.equal((await app.inject(plain)).statusCode, 200);
        const denied = await app.inject({ method, url: encoded });
        assert.equal(denied.statusCode, 429);
        assert.equal(denied.headers["retry-after"], "1");
        assert.equal(denied.headers["cache-control"], "private, no-store");
        assert.equal(
          (await app.inject({ method, url: encoded })).statusCode,
          429,
          "rate rejection releases the only delivery concurrency slot",
        );
      } finally {
        config.DELIVERY_REQUESTS_PER_SECOND = oldRate;
        config.DELIVERY_MAX_INFLIGHT = oldConcurrency;
        await app.close();
      }
    });

    test(`delivery concurrency gate covers encoded ${method} ${route}`, async () => {
      const old = config.DELIVERY_MAX_INFLIGHT;
      config.DELIVERY_MAX_INFLIGHT = 1;
      const app = Fastify();
      registerAdmission(app);
      const stream = new PassThrough();
      let began!: () => void;
      const started = new Promise<void>((yes) => {
        began = yes;
      });
      app.get("/w/slow", async () => {
        began();
        return stream;
      });
      app.get(route, async () => "ok");
      const running = app.inject("/w/slow").then((response) => response);
      try {
        await started;
        const denied = await app.inject({ method, url: encoded });
        assert.equal(denied.statusCode, 503);
        assert.equal(denied.headers["retry-after"], "1");
        assert.equal(denied.headers["cache-control"], "private, no-store");
        stream.end("ok");
        await running;
        assert.equal((await app.inject({ method, url: encoded })).statusCode, 200);
      } finally {
        if (!stream.writableEnded) stream.end("ok");
        await running;
        config.DELIVERY_MAX_INFLIGHT = old;
        await app.close();
      }
    });
  }

test("only matched health routes bypass full API admission, including encoded GET and HEAD", async () => {
  const old = config.API_MAX_INFLIGHT;
  config.API_MAX_INFLIGHT = 1;
  const app = Fastify();
  registerAdmission(app);
  const stream = new PassThrough();
  let began!: () => void;
  const started = new Promise<void>((yes) => {
    began = yes;
  });
  app.get("/api/slow", async () => {
    began();
    return stream;
  });
  const healthRoutes = [
    "/health", "/ready", "/api/operations/health", "/api/operations/metrics",
  ];
  for (const route of healthRoutes) app.get(route, async () => "ok");
  app.get("/health/expensive", async () => "ok");
  const running = app.inject("/api/slow").then((response) => response);
  try {
    await started;
    for (const route of healthRoutes)
      for (const method of ["GET", "HEAD"] as const) {
        assert.equal((await app.inject({ method, url: route })).statusCode, 200);
        const encoded = route.replace(
          /\/([^/])/,
          (_, first: string) => `/%${first.charCodeAt(0).toString(16)}`,
        );
        assert.equal((await app.inject({ method, url: encoded })).statusCode, 200);
      }
    assert.equal((await app.inject("/health/expensive")).statusCode, 503);
    assert.equal((await app.inject({ method: "POST", url: "/health" })).statusCode, 503);
    assert.equal((await app.inject("/unknown")).statusCode, 503);
  } finally {
    if (!stream.writableEnded) stream.end("ok");
    await running;
    config.API_MAX_INFLIGHT = old;
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
