import cliPackage from "../../cli/package.json" with { type: "json" };

export const CLI_SETUP_VERSION = cliPackage.version;

// Quote each value as one POSIX shell argument, including pasted hostnames.
function shellArgument(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cliSetupCommand(
  server: string,
  workspace: string,
  vard: string,
) {
  const cli = "npx --no-install vardum";
  return [
    `npm install --save-dev --save-exact @vardum/cli@${CLI_SETUP_VERSION}`,
    `${cli} init --server ${shellArgument(server)} --workspace ${shellArgument(workspace)} --vard ${shellArgument(vard)}`,
    `${cli} login`,
    `${cli} pull`,
  ].join(" && ");
}
