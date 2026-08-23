import assert from "node:assert/strict";
import test from "node:test";
import { deliveryWindowStart, fillDeliveryDays } from "./delivery-analytics.js";

test("delivery analytics fills a 30-day UTC series without inventing requests", () => {
  const now = new Date("2026-08-21T23:30:00-07:00");
  const series = fillDeliveryDays(
    [
      {
        date: "2026-08-22",
        requests: 3,
        transformed: 2,
        bytes: 1200,
        cacheHits: 1,
        cacheMisses: 1,
      },
    ],
    now,
  );

  assert.equal(
    deliveryWindowStart(now).toISOString(),
    "2026-07-24T00:00:00.000Z",
  );
  assert.equal(series.length, 30);
  assert.deepEqual(series[0], {
    date: "2026-07-24",
    requests: 0,
    transformed: 0,
    bytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
  });
  assert.deepEqual(series.at(-1), {
    date: "2026-08-22",
    requests: 3,
    transformed: 2,
    bytes: 1200,
    cacheHits: 1,
    cacheMisses: 1,
  });
});
