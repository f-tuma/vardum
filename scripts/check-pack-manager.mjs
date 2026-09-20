import { readFileSync } from "node:fs";

const { packageManager } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = packageManager.replace("@", "/");
if (!process.env.npm_config_user_agent?.startsWith(`${expected} `)) {
  throw new Error(
    `Pack with ${packageManager} using scripts/pack-release.sh. npm pack/publish does not rewrite workspace: dependencies.`,
  );
}
