# Client 0.8.2: adopt existing matching outputs

Published and independently verified **2026-10-13** for **VARD-97**: CLI
**0.8.2**, with unchanged shared **0.4.1** and MCP **0.4.1**. Anonymous registry
bytes, independent public CLI/MCP installs with transitive shared, 12 adoption
checks on the public CLI, and all four GitHub release assets match the original
final-tag tested batch. Active onboarding and gateway source Copy setup pin
CLI 0.8.2; the deployed gateway requires a separate deployment.

## Existing project files

CLI 0.8.2 adds explicit lock-only adoption for projects whose mapped outputs
already exist. Inspect the plan first, then record their verified snapshot:

```sh
npx --no-install vardum status --adopt-existing --json
npx --no-install vardum pull --adopt-existing --json
```

All current outputs must be present and match their actual immutable downloads,
including pinned versions and transformed outputs. Missing or outdated outputs
are `download` decisions; different or locally edited tracked files are
`conflict` decisions. Either blocks adoption. No asset file is replaced.
Status and dry-run retain no project or update-cache writes. Apply publishes one
complete schema 2 lock after rechecking captured files, parent paths,
configuration and the previous snapshot.

The flag is also available through `sync`. It cannot combine with `--frozen`,
`--force`, `--delete`, context overrides or positional arguments. Ordinary pull
conflict behavior remains unchanged. Current CLI pull, push and pull-asset
writers share a cooperative mutex; older clients and arbitrary editors do not.
Detected drift aborts adoption. Atomic snapshot publication does not promise a
filesystem transaction that excludes future edits. If a process crashes,
confirm it has stopped before removing `.vardum.snapshot.mutex`.

## Compatibility and package batch

Schema **2**, minimum CLI **0.6.0**, folder upload/resume/import behavior and
guarded MCP editor protocols remain unchanged. This feature uses existing
manifest and immutable-delivery routes; it requires no new server capability.
The separate first-project/server compatibility fixture stays **0.6/0.2/0.2**.
Source dependencies stay `workspace:^`; the CLI archive requires shared
`^0.4.1`.

The source workflow packs all three packages. Shared and MCP source content is
unchanged; their final tag-run archives were byte-identical to the published 0.4.1
archives. Complete-batch registry preflight verified that identity before
skipping their existing versions and publishing only CLI 0.8.2. Any difference
remains a publication blocker for recovery. No historical version, tag or
archive is replaced.

## Publication evidence

[Release `v0.8.2`](https://github.com/f-tuma/vardum/releases/tag/v0.8.2) identifies
source `7cf45661efdbe2f30b1a91b393c44a3e7ef2bbda`, tree
`95ad4b6ab0acc96ba1e54f0799fb6ea31ae1e29a`. Annotated tag object
`a6cea9fed4af1492660c135278805820f40f2aa2` is unsigned.
[PR #52](https://github.com/f-tuma/vardum/pull/52) was reviewed at
`859987ff029689aa87425bddfad2e6af76e5b011` and passed
[CI 38394288452](https://github.com/f-tuma/vardum/actions/runs/38394288452).
Reviewed, virtual-merge and actual squash trees matched exactly.
[Branch validation-only 38394294864](https://github.com/f-tuma/vardum/actions/runs/38394294864)
passed archive/download/install checks with publication skipped; its batch
never substituted for the final matching-tag batch.

| Evidence | Recorded identity |
| --- | --- |
| Final tag run | [38397611904](https://github.com/f-tuma/vardum/actions/runs/38397611904), attempt **1**, successful validation and publisher |
| Validation job | [115296743424](https://github.com/f-tuma/vardum/actions/runs/38397611904/job/115296743424), tests/types/build, auth/PG/private, archive/install and production/clean-restore smoke passed |
| Publisher job | [115303501617](https://github.com/f-tuma/vardum/actions/runs/38397611904/job/115303501617), OIDC CLI publication, registry/public installs and GitHub assets passed |
| Original npm artifact | **11813882726**, `npm-7cf45661efdbe2f30b1a91b393c44a3e7ef2bbda`, created `2026-10-13T12:44:57Z`; downloaded ZIP **63,010 bytes**, SHA-256 `86724607d95447e99eced47a74e7c938087ddb436473baf107dc5f805c82045e` |
| Independent public proof | `2026-10-13T12:48:58.585Z`; Node **22.23.3** / npm **12.2.0**; separate anonymous projects/configs/caches, only named CLI or MCP installed |

The publisher downloaded its own successful validation batch. Shared and MCP
0.4.1 were verified and skipped; only CLI 0.8.2 was newly published. All four
original files passed manifest/archive gates and later byte comparisons:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `release.json` | 713 | `bc21873bc5c57e83a9fe5517a7350d17c95c0c242470d1e80b43f46f11e8204b` |
| `vardum-cli-0.8.2.tgz` | 45,193 | `58bc1d26d54a31e5454b6a840eeb331f246814e831732b05ee2d611188abb260` |
| `vardum-mcp-0.4.1.tgz` | 12,290 | `1e0415c45a5f8135082095fa45f9757322c477c2b51e5ee279a9a762b9f15d8a` |
| `vardum-shared-0.4.1.tgz` | 4,568 | `894b0e417a463cb5c7e39c377824d149745283d136d1abefc5d251f367752caf` |

| Archive | SHA-512 integrity |
| --- | --- |
| `vardum-shared-0.4.1.tgz` | `sha512-VzV+nX6XeTeIttQSbzHuzFVSF/FuFuK9oiteYACbFGudRmDk/zmyH+qGWMGl5EVd3O07Wea2Z26iBYqZbykYNg==` |
| `vardum-cli-0.8.2.tgz` | `sha512-ohiQKFe61bQbgkK1qYDHo0Rew6JfZjWzk8sXDT9ToANz6NhK+hFCxZy/Rc2HNHOlJvbynDhNZI0zmg6217Yzjg==` |
| `vardum-mcp-0.4.1.tgz` | `sha512-wLBMopjYLphXM4n/vvL/X8ajouZJG8sY12NFCbnfKPGfb8ZVebsTuCk5F+Zl78KSi7mbmxmI4l1zUJJC7OnHIw==` |

Actual anonymous npm metadata and downloaded tarballs matched the manifest
integrities and sizes. Independent public CLI **0.8.2** and MCP **0.4.1** installs
each resolved shared **0.4.1** transitively, and their executable versions
matched. CLI init dry-run/create/repeat/conflict/missing-flags checks passed.
The public-installed CLI also passed all **12** adoption checks: original,
transformed and pinned bytes; dry-run; default conflict; restoration of the old
frozen snapshot after live changes; incompatible flags; missing/different files;
authorization and redirect refusal. These are loopback fixtures, not a human
consent or real Musubi pilot test.

GitHub release **411668156** has exactly four assets, all downloaded and
byte-compared with the original files above:

| Asset | Asset ID | Bytes |
| --- | --- | --- |
| `release.json` | **637018213** | **713** |
| `vardum-cli-0.8.2.tgz` | **637018262** | **45,193** |
| `vardum-mcp-0.4.1.tgz` | **637018287** | **12,290** |
| `vardum-shared-0.4.1.tgz` | **637018229** | **4,568** |

The checksum-verified named sanitized runtime artifact **11814392685** has
downloaded ZIP **10,624 bytes**, SHA-256
`65b86bc18efb18135c34d1801e45ab754122775d46f728bc955d7fc2fec788cf`. Its summary
records clean source/tree and workflow success, while reporting `offlineReplay: false` and
`releaseCertification: not-provided`. It does not certify a released server,
close native findings or prove deployed gateway/provider acceptance.

## Upgrade order

1. Install `@vardum/cli@0.8.2` with `--save-dev --save-exact` and commit the
   package-manager lockfile. Keep the schema 2 `.vardum.lock`; no migration is
   needed. MCP configuration stays pinned to `@vardum/mcp@0.4.1`.
2. Adoption requires existing manifest/immutable-delivery routes and a read key
   for private files, with no new server capability. For library upload/import,
   still verify migration `0015_upload_request_checksum.sql` and
   `folderUploadResume: 1` / `folderVardImport: 1`. Guarded MCP editable reads and
   mutations still need `vardEditRevision: 1`.
3. Preview `status --adopt-existing --json` for already matching project files;
   otherwise keep ordinary pull and its conflict protections. Commit the lock
   and use `pull --frozen --json` in CI. Locked bytes still depend on retention,
   signing, authorization and [derived-output preservation](adr/0001-derived-output-preservation.md).
4. Deploy the promoted gateway source to offer Copy setup with CLI 0.8.2.
   Package publication and source pin promotion do not establish the live UI
   version or complete the Musubi pilot.

## Recovery and immutability

Keep `v0.8.2`, its source tree and original artifact **11813882726** immutable.
Do not repack published versions or move the tag. Recover an interrupted
publisher only through failed jobs of original run **38397611904**; a fresh
dispatch or full rerun would repack. Stop if the original batch is unavailable
or registry/GitHub bytes conflict. Documentation and gateway pin commits do not
change the tag or archived READMEs.

This client release does not certify a production server artifact, deploy the
gateway or complete the Musubi pilot. An accepted Node 26 candidate is separate;
the source-release workflow retains Node **22.23.3**.
