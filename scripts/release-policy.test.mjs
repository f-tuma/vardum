import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseValidationOnly, releasePolicy } from "./release-policy.mjs";

const cli = JSON.parse(
  await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
);
const expectedRef = `refs/tags/v${cli.version}`;
const cases = [
  ["matching tag push", "push", expectedRef, false, true],
  ["mismatching tag push", "push", "refs/tags/v999.0.0", false, null],
  ["branch push", "push", "refs/heads/main", false, null],
  ["push with validation-only input", "push", expectedRef, true, null],
  ["matching tag retry", "workflow_dispatch", expectedRef, false, true],
  ["mismatching tag retry", "workflow_dispatch", "refs/tags/v999.0.0", false, null],
  ["branch dispatch with default false", "workflow_dispatch", "refs/heads/main", false, null],
  ["branch validation", "workflow_dispatch", "refs/heads/main", true, false],
  ["matching tag validation", "workflow_dispatch", expectedRef, true, false],
  ["mismatching tag validation", "workflow_dispatch", "refs/tags/v999.0.0", true, false],
  ["pull request", "pull_request", expectedRef, false, null],
  ["unknown event", "unknown", "refs/heads/main", true, null],
];

for (const [name, eventName, ref, validationOnly, publicationAllowed] of cases) {
  test(`release policy: ${name}`, async () => {
    const input = { eventName, ref, cliVersion: cli.version, validationOnly };
    if (publicationAllowed === null) {
      assert.throws(() => releasePolicy(input));
    } else {
      assert.deepEqual(releasePolicy(input), { expectedRef, publicationAllowed });
    }
    // Exercise the exact commands wired into Actions, including the independent
    // publish guard. These guards never invoke a registry or publisher.
    const root = await mkdtemp(join(tmpdir(), "vardum-release-policy-"));
    try {
      for (const command of ["validate", "publish"]) {
        const output = join(root, `${command}.output`);
        const result = spawnSync(process.execPath, [
          fileURLToPath(new URL("./release-policy.mjs", import.meta.url)),
          command,
        ], {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: eventName,
            GITHUB_REF: ref,
            RELEASE_VALIDATION_ONLY: String(validationOnly),
            GITHUB_OUTPUT: output,
          },
        });
        const permitted = command === "validate"
          ? publicationAllowed !== null
          : publicationAllowed === true;
        assert.equal(result.status, permitted ? 0 : 1, result.stderr);
        if (command === "validate" && permitted) {
          assert.equal(await readFile(output, "utf8"), `expected_ref=${expectedRef}\n`);
        } else {
          await assert.rejects(readFile(output), { code: "ENOENT" });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("validation-only input parsing rejects values outside Actions boolean strings", () => {
  for (const value of [undefined, "", "false"])
    assert.equal(parseValidationOnly(value), false);
  assert.equal(parseValidationOnly("true"), true);
  for (const value of ["TRUE", "False", "0", "1", "null", "yes", "{}"])
    assert.throws(() => parseValidationOnly(value), /must be true or false/);
  for (const validationOnly of [undefined, null, "true", "false", 0, 1])
    assert.throws(() => releasePolicy({
      eventName: "workflow_dispatch", ref: expectedRef,
      cliVersion: cli.version, validationOnly,
    }), /must be a boolean/);
});

test("release output cannot contain malformed versions or line injection", () => {
  for (const cliVersion of [undefined, "", "latest", "0.6.0\n", "0.6.0\nother=true"]) {
    assert.throws(() => releasePolicy({
      eventName: "workflow_dispatch", ref: expectedRef,
      cliVersion, validationOnly: true,
    }), /Invalid CLI release version/);
  }
});

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
function workflowJob(name) {
  const start = workflow.indexOf(`    ${name}:\n`);
  assert.ok(start >= 0, `Missing ${name} job`);
  const remainder = workflow.slice(start + 5);
  const next = remainder.search(/\n {4}[a-z][a-z-]*:\n/);
  return next < 0 ? remainder : remainder.slice(0, next);
}

test("workflow publication gate independently enforces event, exact CLI tag and mode", () => {
  const validate = workflowJob("validate");
  const publish = workflowJob("publish");
  const condition = publish.match(/\n {8}if: >-\n([\s\S]*?)\n {8}runs-on:/)?.[1]
    .trim().replace(/\s+/g, " ");
  assert.equal(condition,
    "needs.validate.outputs.expected_ref == github.ref && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.validation_only == false))");
  assert.match(publish, /needs: validate/);
  assert.match(validate, /expected_ref: \$\{\{ steps\.policy\.outputs\.expected_ref \}\}/);
  assert.match(validate, /id: policy\n {14}run: node scripts\/release-policy\.mjs validate/);
  for (const job of [validate, publish])
    assert.match(job, /RELEASE_VALIDATION_ONLY: \$\{\{ inputs\.validation_only \}\}/);
  const guard = publish.indexOf("run: node scripts/release-policy.mjs publish");
  assert.ok(guard > publish.indexOf("node-version: 22.23.3"));
  assert.ok(guard < publish.indexOf("run: npm install --global"));
  assert.ok(guard < publish.indexOf("run: node scripts/release-packages.mjs publish"));
  assert.doesNotMatch(publish, /continue-on-error:/);
  assert.ok(validate.indexOf("node-version: 22.23.3") < validate.indexOf("run: node scripts/release-policy.mjs validate"));
});

test("manual validation downloads the tested artifact with read-only permissions", () => {
  const validate = workflowJob("validate");
  const download = workflowJob("validate-download");
  assert.match(workflow, /validation_only:\n {16}description:.*\n {16}type: boolean\n {16}default: false/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(download, /needs: validate/);
  assert.match(download, /if: github\.event_name == 'workflow_dispatch' && inputs\.validation_only == true/);
  assert.match(download, /permissions:\n {12}contents: read/);
  assert.match(validate, /uses: actions\/upload-artifact@[a-f0-9]{40}/);
  for (const job of [validate, download]) {
    assert.match(job, /name: npm-\$\{\{ github\.sha \}\}/);
    assert.match(job, /path: artifacts\/npm\//);
    assert.doesNotMatch(job, /environment:|id-token:|contents: write|release-packages\.mjs (?:publish|verify-registry)|npm publish|gh release/);
  }
  assert.match(download, /uses: actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(download, /run: node scripts\/release-packages\.mjs check artifacts\/npm/);
  assert.match(download, /run: bash scripts\/smoke-publish\.sh artifacts\/npm/);
  assert.doesNotMatch(download, /run-id:|repository:|github-token:|continue-on-error:/);
});
