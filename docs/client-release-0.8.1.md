# Client 0.8.1 public onboarding patch

Published and independently verified **2026-10-11** for **VARD-77**: CLI
**0.8.1**, MCP **0.4.1** and shared **0.4.1**. Anonymous registry tarballs,
independent public CLI/MCP installs with transitive shared 0.4.1, and all four
GitHub release assets match the original final-tag tested batch.

This patch makes the package READMEs usable without source-repository access:
standalone exact-version setup, public npm links and backend/retention contracts.
The archive gate checks packaged documentation and installation pins. It retains
schema **2** snapshots, the CLI 0.8 complete folder plan, resumable upload/import
and the MCP 0.4 guarded-editor contract and **11 tools**. Minimum schema 2 CLI is
still **0.6.0**. The first-project/server compatibility fixture remains
0.6/0.2/0.2. [0.8 feature notes](client-release-0.8.md) and
[0.7 release evidence](client-release-0.7.md) remain immutable historical records;
VARD-14's schema 3 draft remains unmerged and unpublished.

## Publication evidence

[Release `v0.8.1`](https://github.com/f-tuma/vardum/releases/tag/v0.8.1) identifies
source `2e5c62a1da587d1dfc1f8f7508142715971c1075`, tree
`99b42aebdbd657de873f343e3605802af87f31dc`. The annotated tag object is
`8a7dce28c5331dbcc4210cd0cb0e3400611c5a2b` (unsigned).
[PR #43](https://github.com/f-tuma/vardum/pull/43) was independently reviewed at
`0f6b77a365e8ad28955f01e3c4ab406127aa511f` and passed
[CI 38161671539](https://github.com/f-tuma/vardum/actions/runs/38161671539).
The [branch validation-only run 38161676456](https://github.com/f-tuma/vardum/actions/runs/38161676456)
passed archive/download/install checks with publication **skipped**. Its archives
are a separate batch, never substituted for the final tag run's archives.

| Evidence | Recorded identity |
| --- | --- |
| Final matching-tag run | [Actions 38162972385](https://github.com/f-tuma/vardum/actions/runs/38162972385), original attempt **1**, successful failed-job recovery attempt **2** |
| Original successful validation | [Job 114539578444](https://github.com/f-tuma/vardum/actions/runs/38162972385/job/114539578444), attempt **1**; tests/typecheck/build, auth/database/private-delivery checks, archive checks, installed-package production/backup-restore smoke and sanitized evidence preparation passed |
| Original npm artifact | **11710699527**, `npm-2e5c62a1da587d1dfc1f8f7508142715971c1075`, created **2026-10-11 18:30:35 UTC**, downloaded ZIP **58,768 bytes**, SHA-256 `a2ec0a844b656ff363f43c199124578fdfa1c58b01d7be3e6eba957dfcbdf5e8` |
| Original publisher | [Job 114542973734](https://github.com/f-tuma/vardum/actions/runs/38162972385/job/114542973734), attempt **1**; all three OIDC publications succeeded, registry-install verification failed with npm `ETARGET`, GitHub release step skipped |
| Recovered publisher | [Job 114543911682](https://github.com/f-tuma/vardum/actions/runs/38162972385/job/114543911682), attempt **2**, **success**; downloaded the same original artifact and skipped identical published archives |
| Manifest | `release.json`, schema **1**, **713 bytes**, SHA-256 `ec8edd4fa4461d23b963c8a88b61c3410f8edc8619b903d458230177e5d26db9`; contains the three filenames, versions and SHA-512 integrities below |
| Independent proof checkpoint | **2026-10-11 18:36:33 UTC**; original ZIP and extracted-file checksums, anonymous registry archive bytes, independent public installs and downloaded release assets checked |

The publisher downloaded exactly its own run's successful validation archive in
both attempts. Attempt 1 published shared → CLI → MCP through OIDC, then npm's
independent CLI installation failed with `ETARGET: No matching version found for
@vardum/cli@0.8.1` during propagation. Only failed jobs of the original tag run
were rerun. Attempt 2 retained the original successful validation and original
artifact, logged all three archives as identical/already published, passed
registry verification and independent installs, then created the GitHub release.
There was no full rerun, repack, tag move or manual npm write. Bounded automatic
install-propagation retry work is tracked separately in **VARD-96**.

### Tested and public archive bytes

Each anonymous registry metadata response supplied the matching integrity and
archive URL; each actual downloaded tarball was byte-identical to the original
artifact archive. CLI/MCP source dependencies stay `workspace:^`; the published
manifests contain `@vardum/shared: ^0.4.1`.

| Package | Original archive | Bytes | SHA-256 |
| --- | --- | --- | --- |
| [`@vardum/shared@0.4.1`](https://registry.npmjs.org/%40vardum%2Fshared/0.4.1) | [`vardum-shared-0.4.1.tgz`](https://registry.npmjs.org/@vardum/shared/-/shared-0.4.1.tgz) | 4,568 | `894b0e417a463cb5c7e39c377824d149745283d136d1abefc5d251f367752caf` |
| [`@vardum/cli@0.8.1`](https://registry.npmjs.org/%40vardum%2Fcli/0.8.1) | [`vardum-cli-0.8.1.tgz`](https://registry.npmjs.org/@vardum/cli/-/cli-0.8.1.tgz) | 40,953 | `d475c6555f4a320b3b90c527a96842224aba01924b43addcf8b0d0ec584e9236` |
| [`@vardum/mcp@0.4.1`](https://registry.npmjs.org/%40vardum%2Fmcp/0.4.1) | [`vardum-mcp-0.4.1.tgz`](https://registry.npmjs.org/@vardum/mcp/-/mcp-0.4.1.tgz) | 12,290 | `1e0415c45a5f8135082095fa45f9757322c477c2b51e5ee279a9a762b9f15d8a` |

The manifest and registry SHA-512 integrities were:

| Archive | SHA-512 integrity |
| --- | --- |
| `vardum-shared-0.4.1.tgz` | `sha512-VzV+nX6XeTeIttQSbzHuzFVSF/FuFuK9oiteYACbFGudRmDk/zmyH+qGWMGl5EVd3O07Wea2Z26iBYqZbykYNg==` |
| `vardum-cli-0.8.1.tgz` | `sha512-cvVOqDCmjqhLseS6JffdUFZ7v27Nx4deJisM3j7mbIEmogWoj4F/OuXE1NeAiOagHb0dmaqfjYss3TPr5JFGCQ==` |
| `vardum-mcp-0.4.1.tgz` | `sha512-wLBMopjYLphXM4n/vvL/X8ajouZJG8sY12NFCbnfKPGfb8ZVebsTuCk5F+Zl78KSi7mbmxmI4l1zUJJC7OnHIw==` |

The original artifact passed `release-packages.mjs check`; the later local
`release-packages.mjs verify-registry` passed. An earlier local verification
also encountered install propagation `ETARGET`; it did not modify the archives
or publish packages.

### Independent public installations

Independent empty npm projects used an anonymous npmjs configuration and
separate caches on Node **22.23.3** / npm **12.2.0**. Only the named client was
installed in each project; shared was never explicitly installed. The commands below shorten each recorded absolute configuration path to the
project-local `.npmrc`:

```sh
npm install --userconfig ./.npmrc --ignore-scripts --no-audit --no-fund @vardum/cli@0.8.1
npm install --userconfig ./.npmrc --ignore-scripts --no-audit --no-fund @vardum/mcp@0.4.1
```

The commands ran from their respective empty CLI/MCP projects, with each
`--userconfig` path pointing to that project's anonymous configuration.
CLI installed at **0.8.1** and `vardum version` printed `0.8.1`; MCP installed at
**0.4.1** and `vardum-mcp --version` printed `0.4.1`. Each resolved shared
**0.4.1** transitively through `^0.4.1`.

The independently installed public CLI exercised non-interactive init:

| Case | Recorded result |
| --- | --- |
| Dry-run | Exit **0**, `applied: false`, no `vardum.json` created |
| Create | Exit **0**, `changed: 1`; config SHA-256 `eef8be71b533480c6baa7c61904a67f8d52d38987925752d9ea3d06446439780` |
| Identical repeat | Exit **0**, `changed: 0`, config unchanged |
| Conflicting config | Exit **1**, force required, config unchanged |
| Missing non-interactive flags | Exit **1**, `--workspace` and `--vard` required, config unchanged |

These automated installs and local init checks do not observe a person's browser
consent or complete a human first-use session.

### GitHub release assets

[GitHub release **409848020**](https://github.com/f-tuma/vardum/releases/tag/v0.8.1)
was created by recovered attempt **2**. All four assets were downloaded and
byte-compared with the original artifact files; their sizes and SHA-256 values
match the manifest/archive values above.

| Asset | Asset ID | Bytes |
| --- | --- | --- |
| `release.json` | **631496851** | **713** |
| `vardum-shared-0.4.1.tgz` | **631496866** | **4,568** |
| `vardum-cli-0.8.1.tgz` | **631496883** | **40,953** |
| `vardum-mcp-0.4.1.tgz` | **631496897** | **12,290** |

### Sanitized runtime evidence and limits

The original attempt-1 `runtime-image-evidence` artifact **11711716298** was
created **2026-10-11 18:30:33 UTC**. Its downloaded ZIP is **10,592 bytes**,
SHA-256 `f6a8eefedf47355cddf5eb03f7ef57560e7790191e93b22ec6dd231c6421c019`.
Its checksum-verified sanitized summary records the same clean source commit/tree,
`linux/amd64`, production-smoke/job success and evidence completeness. It
explicitly reports `offlineReplay: false` and `releaseCertification: not-provided`.

The recorded TLS result passed **42/42** cases (12 trusted and 10 each rogue,
expired and wrong-SAN); private certificates were removed. Standard, marketing
and fallback gateway checks each passed **39/39** in both production and Dokploy
gateway configurations, including cold start. API/worker runtime records show
Node **22.23.3**, UID **65532**, zero development packages, sharp **0.35.5** and
libvips **8.18.7**; scanner records contain API **23 medium / 8 low** findings and
no gateway findings. The summary's individual deployed SVG rasterization, AVIF
encode/decode and runtime database-role checks are **not individually recorded**.
These are workflow observations, not certification of a released production
server/runtime artifact or closure of residual findings. See
[current readiness status](production-readiness-2026-09-20.md#current-status).

## Upgrade order

1. Verify the intended server's migrations through
   `0015_upload_request_checksum.sql` and capabilities. Resumable library
   mutation requires `folderUploadResume: 1`; Vard import, including dry-run,
   also requires `folderVardImport: 1`. MCP editable reads and mutations require
   `vardEditRevision: 1` and the guarded revision/manual-ID/literal-pin contract.
2. Install the exact public CLI in each project:

   ```sh
   npm install --save-dev --save-exact @vardum/cli@0.8.1
   ```

   Commit `package.json` and the package-manager lockfile. Keep the schema 2
   `.vardum.lock`; no snapshot migration is needed. Pin MCP configuration to
   `@vardum/mcp@0.4.1`. Use Node.js **22 or newer**.
3. Review `vardum status` and folder `--dry-run --json` before applying. A separate
   normal pull intentionally updates delivered files and the snapshot; CI uses
   `vardum pull --frozen`. Locked URLs still depend on retention, signing,
   authorization and byte preservation, including the
   [derived-output preservation contract](adr/0001-derived-output-preservation.md).
4. Gateway source **Copy setup** now uses an independently reviewed verified
   public CLI constant **0.8.1**. Deploy that gateway source to update the live
   command; package manifests and source documentation do not prove the deployed
   UI version.

Publication does not complete the Musubi pilot, a new human first-use session or
server/runtime/provider/backup/restore/capacity acceptance.

## Recovery and immutability

Keep `v0.8.1`, its source tree and the original tested artifacts immutable.
Post-publication documentation and gateway pin changes do not alter the packed
README bytes or the tag. Never repack source under these published versions or
route this source batch through the retained 0.7 controller.

For a failed publisher, rerun only failed jobs of the original tag run:

```sh
gh run rerun 38162972385 --repo f-tuma/vardum --failed
```

A new dispatch or full rerun would repack and is not recovery of this batch.
Retain original artifact **11710699527** and its ZIP/file hashes; if it becomes
unavailable, stop and review recovery before publication. Identical published
bytes must be skipped; conflicting bytes require a new version and candidate.
See the [release procedure](npm-release.md#publish).
