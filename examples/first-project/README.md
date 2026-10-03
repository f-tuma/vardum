# First project

Use Node.js 22 or newer and a Vardum server with recursive folder rules and
schema 2 snapshots. This small consumer pins the published **@vardum/cli 0.6.0**
and its public npm lockfile. It uses three SVG originals, with no transformations.

1. Copy this directory into a new project outside the Vardum source workspace:

   ```sh
   cp -R examples/first-project /path/to/my-project
   cd /path/to/my-project
   ```

2. In your workspace, upload the three files below with these exact asset keys.
   Leave the assets private and wait until each is Ready:

   | Local fixture | Workspace asset key |
   | --- | --- |
   | `sample/logo.svg` | `sample/logo.svg` |
   | `sample/brand/badge.svg` | `sample/brand/badge.svg` |
   | `sample/brand/icons/check.svg` | `sample/brand/icons/check.svg` |

3. Create a private Vard named **First project**. Add one manual mapping from
   `sample/logo.svg` to `public/logo.svg`, following Latest with **Writable off**.
   Add one recursive folder rule from `sample/brand/` to `public/brand/`. The rule
   includes the badge and nested check icon and generates read-only outputs.
   Its resolved preview should show exactly three files.

4. Open the Vard's Setup tab and copy its server URL, workspace ID and Vard
   ID. Install the exact CLI and initialize with those values:

   ```sh
   npm install --save-dev --save-exact @vardum/cli@0.6.0 --registry=https://registry.npmjs.org/
   npx --no-install vardum version
   npx --no-install vardum init --server https://YOUR-SERVER --workspace YOUR-WORKSPACE-ID --vard YOUR-VARD-ID
   npx --no-install vardum login
   ```

   In the browser, authorize the selected workspace with **Pull only** access.
   The credential stays outside the project in the CLI's configuration directory
   with mode `0600`. Never copy it or an API key into repository files.

5. Pull and verify the actual bytes and snapshot:

   ```sh
   npx --no-install vardum pull
   npm run verify
   ```

   Success prints `Verified 3 exact fixture files, output paths and schema 2
   snapshot checksums`. The outputs are `public/logo.svg`,
   `public/brand/badge.svg` and `public/brand/icons/check.svg`. Verification fails
   for missing/extra outputs, changed bytes or incorrect snapshot membership or
   SHA-256 checksums. `public/` is ignored because frozen pull restores it.

6. Review `vardum.json` and `.vardum.lock`, then commit them with the project and
   npm files. The snapshot contains immutable version URLs, not credentials:

   ```sh
   git init
   git add README.md .gitignore sample verify.mjs package.json package-lock.json vardum.json .vardum.lock
   git commit -m "Add reviewed Vardum asset snapshot"
   ```

7. On a clean checkout or in CI, provide a workspace **read** key through your
   secret store as `VARDUM_API_KEY`, then restore the reviewed snapshot:

   ```sh
   npm ci
   npx --no-install vardum pull --frozen --json
   npm run verify
   ```

   Frozen pull preserves the committed membership and version bytes even when
   the live Vard changes. A second pull reports `changed: 0`. The server must
   retain the locked versions and keep their source keys and URLs reachable.
   To deliberately adopt remote changes, run normal pull and review the new
   snapshot; this verifier expects the original three-file example.

For the existing configuration workflow, see the [CLI setup guide](https://github.com/f-tuma/vardum/blob/main/apps/cli/README.md#first-project)
and [Vards and CLI sync](https://github.com/f-tuma/vardum/blob/main/README.md#vards-and-cli-sync). Folder rule limits
and membership updates are in [the CLI guide](https://github.com/f-tuma/vardum/blob/main/apps/cli/README.md#folder-membership-updates).

The disposable production smoke runs this flow with the public npm CLI, private
uploads and a simulated login callback, then restores a second clean consumer
with a read key after remote version and membership changes. This checks the
integration; it does not measure a person's browser consent or first-use experience.
