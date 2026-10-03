import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseValidationOnly(value) {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("validation_only must be true or false");
}

export function releasePolicy({ eventName, ref, cliVersion, validationOnly }) {
  if (!["push", "workflow_dispatch"].includes(eventName))
    throw new Error(`Unsupported release event: ${eventName}`);
  if (typeof validationOnly !== "boolean")
    throw new Error("validation_only must be a boolean");
  if (
    typeof cliVersion !== "string" ||
    cliVersion.trim() !== cliVersion ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cliVersion)
  )
    throw new Error("Invalid CLI release version");
  if (eventName === "push" && validationOnly)
    throw new Error("validation_only is only supported for manual dispatch");
  const expectedRef = `refs/tags/v${cliVersion}`;
  const validationDispatch = eventName === "workflow_dispatch" && validationOnly;
  if (!validationDispatch && ref !== expectedRef)
    throw new Error(`Run this release from tag v${cliVersion}`);
  return { expectedRef, publicationAllowed: !validationDispatch };
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!["validate", "publish"].includes(command) || extra.length)
    throw new Error("Usage: node scripts/release-policy.mjs validate|publish");
  const { version } = JSON.parse(
    await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
  );
  const policy = releasePolicy({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    cliVersion: version,
    validationOnly: parseValidationOnly(process.env.RELEASE_VALIDATION_ONLY),
  });
  if (command === "publish" && !policy.publicationAllowed)
    throw new Error("Validation-only dispatch cannot publish");
  if (command === "validate" && process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `expected_ref=${policy.expectedRef}\n`);
  console.log(
    policy.publicationAllowed
      ? `Release tag policy passed: ${policy.expectedRef}`
      : "Validation-only dispatch: publication is disabled",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
