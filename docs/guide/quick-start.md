# Quick start

One file from Vardum into a repository, locked, in five steps.

You need Node.js 22+ and a workspace. These steps use published **CLI 0.7.0**.
Candidate 0.8.0 is unavailable on npm as of 2026-10-11; confirm
[release status](../npm-release.md) before upgrading. Both use schema 2 frozen
snapshots, with minimum compatible CLI 0.6.0.

## 1. Prepare a Vard

In the app:

1. Upload `logo.svg`.
2. Create a Vard.
3. Map the asset to `public/logo.svg`.
4. Copy the server URL, workspace ID and Vard ID. **Copy setup** gives you all
   of step 2 as one command.

## 2. Connect the repository

```sh
npm install --save-dev --save-exact @vardum/cli@0.7.0
npx vardum init     # writes vardum.json
npx vardum login    # authorizes this machine in the browser
```

## 3. Pull

```sh
npx vardum pull     # writes public/logo.svg and .vardum.lock
```

## 4. Commit

```text
vardum.json         server, workspace, Vard
.vardum.lock        versions and checksums
package.json        the pinned CLI
package-lock.json
```

## 5. Restore in CI

Give CI a read key as `VARDUM_API_KEY`, then:

```sh
npm ci
npx --no-install vardum pull --frozen --json
```

Every build now gets the same bytes until you run `vardum pull` again.

## Next

- [Concepts](concepts.md): what a Vard can hold.
- [Use assets in a project](pull.md): updates, conflicts and CI.
- A runnable three-file example with a verifier:
  [examples/first-project](../../examples/first-project/README.md).
