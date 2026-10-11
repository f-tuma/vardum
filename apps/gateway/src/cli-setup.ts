// Last independently verified public release. Candidate package versions must
// not change Copy setup before npm publication and archive verification.
export const CLI_SETUP_VERSION = "0.8.0";

// Quote each value as one POSIX shell argument, including pasted hostnames.
function shellArgument(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cliSetupCommands(
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
  ];
}

export function cliSetupCommand(server: string, workspace: string, vard: string) {
  return cliSetupCommands(server, workspace, vard).join(" && ");
}
