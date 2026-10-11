import assert from "node:assert/strict";
import test from "node:test";
import { waitForPublishedRelease, validatePackageReadme } from "./release-packages.mjs";

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

const readmePackages = [
  { name: "@vardum/shared", version: "0.4.1" },
  { name: "@vardum/cli", version: "0.8.1" },
  { name: "@vardum/mcp", version: "0.4.1" },
];
const cliManifest = readmePackages[1];
const publicReadme = `[CLI](https://www.npmjs.com/package/@vardum/cli/v/0.8.1)
 npm install --save-dev --save-exact @vardum/cli@0.8.1`;

test("packed public README permits standalone HTTPS setup and matching batch pins", () => {
  validatePackageReadme(publicReadme + "\n[App](https://vardum.com)\nnpx -y @vardum/mcp@0.4.1", cliManifest, readmePackages);
});

for (const target of ["../../docs/guide/quick-start.md", "https://github.com/f-tuma/vardum/blob/main/docs/npm-release.md", "http://vardum.com", "https://key:secret@vardum.com"]) {
  test(`packed public README rejects inaccessible or unsafe setup link ${target}`, () => {
    assert.throws(() => validatePackageReadme(publicReadme + `\n[Setup](${target})`, cliManifest, readmePackages));
  });
}

test("packed public README rejects wrong self version, missing install and stale cross-package pins", () => {
  assert.throws(() => validatePackageReadme(publicReadme.replace("/v/0.8.1", "/v/0.8.0"), cliManifest, readmePackages), /exact public npm version/);
  assert.throws(() => validatePackageReadme(publicReadme.split("\n")[0], cliManifest, readmePackages), /exact installation pin/);
  assert.throws(() => validatePackageReadme(publicReadme + "\nnpx -y @vardum/mcp@0.4.0", cliManifest, readmePackages), /installation pin differs/);
});

test("packed README validates reference links and exact npm URL endings", () => {
  assert.throws(() => validatePackageReadme(publicReadme + "\n[setup]: ../../docs/guide/quick-start.md", cliManifest, readmePackages), /public absolute URLs/);
  assert.throws(() => validatePackageReadme(publicReadme.replace("/v/0.8.1)", "/v/0.8.10)"), cliManifest, readmePackages), /exact public npm version/);
  validatePackageReadme("[CLI][version]\n[version]: https://www.npmjs.com/package/@vardum/cli/v/0.8.1\nnpm install @vardum/cli@0.8.1", cliManifest, readmePackages);
});
