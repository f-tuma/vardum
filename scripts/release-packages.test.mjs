import assert from "node:assert/strict";
import test from "node:test";
import { waitForPublishedRelease } from "./release-packages.mjs";

test("registry verification waits for every package to propagate", async () => {
  const release = { packages: ["shared", "cli", "mcp"] };
  const delays = [];
  let reads = 0;
  const result = await waitForPublishedRelease(release, {
    attempts: 3,
    delayMs: 10,
    readState: async (input) => {
      assert.equal(input, release);
      reads++;
      return input.packages.map((name, index) => ({
        name,
        published: index < reads,
      }));
    },
    wait: async (ms) => delays.push(ms),
  });
  assert.equal(reads, 3);
  assert.deepEqual(delays, [10, 10]);
  assert.ok(result.every((pkg) => pkg.published));
});

test("available packages need no wait", async () => {
  await waitForPublishedRelease({}, {
    readState: async () => [{ published: true }],
    wait: async () => assert.fail("Unexpected delay"),
  });
});

test("missing packages fail after the bounded number of checks", async () => {
  let reads = 0;
  let waits = 0;
  await assert.rejects(waitForPublishedRelease({}, {
    attempts: 3,
    readState: async () => {
      reads++;
      return [{ published: false }];
    },
    wait: async () => { waits++; },
  }), /Not all release archives are available/);
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

for (const message of ["Conflicting archive integrity", "Registry check failed (403)"]) {
  test(`does not retry ${message}`, async () => {
    const error = new Error(message);
    let reads = 0;
    await assert.rejects(waitForPublishedRelease({}, {
      readState: async () => {
        reads++;
        throw error;
      },
      wait: async () => assert.fail("Unexpected retry"),
    }), (actual) => actual === error);
    assert.equal(reads, 1);
  });
}
