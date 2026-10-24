# MCP 0.4.3 security patch

## Publication status

[MCP **0.4.3**](https://www.npmjs.com/package/@vardum/mcp/v/0.4.3) was published
and independently verified on **2026-10-24** (VARD-119). Active MCP setup guidance
now pins **0.4.3**. CLI **0.8.3** and shared **0.4.2** retain their original
published bytes. Frozen snapshots remain schema **2**; server and native/vendor
release conditions remain separate.

## Scope

MCP 0.4.3 packages the input-validation fix already reviewed in
[PR74](https://github.com/f-tuma/vardum/pull/74): exact Zod 4.6.6 and its required
string-keyed record API. Published MCP 0.4.2 declares `zod: ^3.24.0`; deploying
the server does not change that immutable npm package. The
[Zod advisory](https://github.com/colinhacks/zod/security/advisories/GHSA-mrhx-c7xc-m3w5)
is addressed by the v4 parser, not the compatibility `zod/v3` entry point.

MCP SDK 1.32.1, all eleven tools, guarded editing, rich output recipes, schema 2
snapshots and backend capability requirements remain. The SDK's v4 JSON Schema
conversion expresses UUID constraints and string record keys explicitly; its
object metadata differs from the previous v3 converter. Runtime unknown-key
stripping remains. Existing stdio and actual installed-package checks cover the
advertised schemas and guarded tool behavior.

## Exact package batch

| Package | Version | Archive origin |
| --- | --- | --- |
| `@vardum/shared` | 0.4.2 | Original published archive, verified against registry integrity and bytes |
| `@vardum/cli` | 0.8.3 | Original published archive, verified against registry integrity and bytes |
| `@vardum/mcp` | 0.4.3 | New pinned-pnpm archive from the reviewed clean source |

Only MCP is newly published. The current shared source includes additive types
introduced after shared 0.4.2; repacking it under that version would produce
conflicting bytes. Preserve both existing archives and their historical READMEs.
MCP uses the existing shared runtime export and type contracts. Independent
installs verified the new MCP with actual public shared 0.4.2.

Assemble the three archives and the normal schema-1 `release.json` in a new empty
directory. Use pinned pnpm to pack only `apps/mcp`, copy the two verified original
published archives, and compute each integrity from the final bytes. Keep source,
origin and validation receipts outside that four-file directory. Existing
`release-packages.mjs check`, `preflight`, installed-client checks and `publish`
apply unchanged. Preflight must verify every existing registry archive before any
write; publication skips byte-identical versions and publishes only missing MCP.
Never replace or republish CLI 0.8.3, shared 0.4.2 or MCP 0.4.2.

The source-tag workflow derives its tag from the CLI version. Do not dispatch it
using the old `v0.8.3` tag, move that tag, or replace its GitHub release assets for
this MCP-only patch. Use the owner's approved direct npm publication path after
review and acceptance of this exact archive batch.

## Acceptance and upgrade

Before publication, check frozen dependencies and the unchanged advisory gate,
MCP types/tests/build, the exact archive manifest and README, and independent
installation with a real lockfile and audit. Confirm installed Zod 4.6.6 and the
active v4 parser. Zod 4 still ships v3 compatibility files; their presence is not
an installed v3 package or evidence that MCP uses its parser.

Run the existing complete source-mode production smoke with `SMOKE_RELEASE_DIR`
pointing to this exact batch. This checks all eleven tool behaviors, guarded
editing and current recipes. `SMOKE_PUBLIC_CLIENTS=1` selects the historical
CLI 0.6/MCP 0.2 server baseline and is not acceptance of this new MCP.

After publication, verify actual registry tarball bytes before independent public
installs. Use the existing recipe-only smoke with
`SMOKE_INSTALLED_RECIPES_ONLY=1`, `SMOKE_RECIPE_REGISTRY=public` and the same
`SMOKE_RELEASE_DIR` to verify current tools, recipe saves, conflicts, permissions
and schema 2 frozen outputs. These checks passed for this publication, so active MCP setup guidance pins
`@vardum/mcp@0.4.3`. CLI and shared installation pins remain unchanged.

No new backend capability, migration or live asset edit is required. Existing
private/public permissions, snapshot retention limits and native/vendor server
release conditions remain applicable.

## Publication evidence

The new MCP archive was packed once using pnpm **12.4.2** from clean source
`f463917c144de196780d75767a9ebed7b0acef91`, tree
`4906b508fa2ed272b5007da6e4b024f70e198541`, in
[PR75](https://github.com/f-tuma/vardum/pull/75). Node **22.23.4** and npm
**12.2.1** were used for local acceptance. Subsequent documentation promotion
does not change this source identity or the immutable package bytes.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `vardum-mcp-0.4.3.tgz` | 13,199 | `2fd2fe0096bf77b04eb8824db3659f8effea1dd27411186268033d4e48442922` |
| `vardum-cli-0.8.3.tgz` | 45,597 | `0eba92cff2b70225e83879e7bb7a84127a038900798c765ed25c0cbaa0031c0d` |
| `vardum-shared-0.4.2.tgz` | 5,237 | `3e186dd33c8fe6b8e8b9bbee5521a82d381ccc5274aa38d6db8a5b3a3d440513` |
| `release.json` | — | `efa98cac0212e14aa67cb44ab733e95da75ed6a11b9dc02f6b1d217e4d227681` |

MCP's registry SHA-512 integrity is
`sha512-vaSke4HxjLhzF/i42xl2jxvtgPpIQtE9YgFLFVFv/h3XzSlB55hI+c/Z9ypl3bOaq/lk16/UDCNyaSAPsS+X7g==`.
Anonymous registry metadata and the actual downloaded tarball match these bytes;
the public `latest` tag resolves to **0.4.3**. Registry metadata has no `gitHead`,
so source binding rests on byte equality with the reviewed archive.

Frozen dependency installation, MCP build/types, six stdio tests and 44 release
helper tests passed. The full source dependency audit reported zero findings.
Independent fresh MCP-only consumers, first from the exact archive and then from
public `@vardum/mcp@0.4.3`, generated normal lockfiles and resolved transitive
shared **0.4.2**, SDK **1.32.1** and a single Zod **4.6.6**. Both passed the
unchanged moderate audit gate with zero findings at every severity, all eleven
advertised tool schemas, three invalid-revision guards, UUID metadata and rich
recipe help.
The public and candidate tool schemas match exactly.

The exact four-file batch passed the full local source-mode production smoke:
all eleven tool behaviors, guarded editing, seven rich recipe checks, schema 2
frozen outputs, library plans and folder imports. Backup/restore recovered
**52 objects / 17,857,121 bytes**. TLS passed **42/42** assertions; both gateway
routing records passed **213** assertions each plus DNS and cold-start recovery.
Private test certificates and both synthetic stacks were removed.

[Source CI run 40087877849, attempt 1](https://github.com/f-tuma/vardum/actions/runs/40087877849)
passed all 26 steps on merge `7c40bd97938537d218dc71e8f8a3bfc9d7a49123`, whose
tree equals the reviewed tree above. Its independently verified sanitized artifact
**12558425228** has ZIP SHA-256
`50d0b502184b340a638db51a02bb709ee2bb85fa9dea7f42665c018df8e31457` and complete
**8/8** projected reports. This ordinary CI source run uses its own image and
archive batch; it does not replace the separate exact mixed-batch acceptance.
The local and hosted API scans retained the same **31 findings (23 medium,
8 low)** on the same scanner database; the standard gateway scan had zero.
Existing server/native assessment remains open.

The owner-approved direct npm publisher verified all three registry versions
before writing, skipped the two byte-identical published packages, and published
only MCP **0.4.3** after normal interactive 2FA. The command completed successfully
at **11:14 UTC**. Existing `verify-registry` then verified actual bytes of all
three public archives and independent public CLI/MCP installs. A separate public
recipe-only backend smoke completed successfully at **11:16 UTC**, using this
same batch and public installations: guarded saves, conflicts, permissions,
all seven recipe checks and schema 2 frozen outputs passed. Final batch hashes
and synthetic-stack cleanup were verified independently.

No new GitHub tag or release assets were created for this MCP-only publication.
The original `v0.8.3` tag, release assets and historical package evidence remain
unchanged. Future recovery must compare public bytes with this retained batch;
never repack or republish an existing version.
