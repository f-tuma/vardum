# Supported Node22 runtime refresh — 24 October 2026

This candidate updates the maintained Node22 patch and the Fastify/Zod dependencies.
It does not publish a server release or change the production deployment.

## Authenticated inputs

The [official Node release](https://nodejs.org/en/blog/release/v22.23.4) and
[bundled OpenSSL version](https://github.com/nodejs/node/blob/v22.23.4/deps/openssl/openssl/VERSION.dat)
identify Node 22.23.4 / OpenSSL 3.5.9. The official index dates the release
20 October; the release page and checksum signatures say 21 October. Both dated
observations are preserved rather than treating the dates as interchangeable.
Node22 remains the selected LTS major; the optional Node26 candidate is unchanged.

| Input | Index digest | Linux/amd64 manifest |
| --- | --- | --- |
| `node:22.23.4-bookworm-slim` | `de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d` | `ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09` |
| `gcr.io/distroless/nodejs22-debian13:nonroot` | `10747a1323be68f206aed893599d43e6697ad67257e7c42703553f99fbce3d33` | `35c9d0d69953b2c1d06a00adafa364d12651fc47b48fc6cbc53565bb905488ff` |

Registry response digests match the saved manifest bytes. Cosign 3.1.4 verified
the exact runtime index against the vendor's
[documented identity and issuer](https://github.com/GoogleContainerTools/distroless#how-do-i-verify-distroless-images):
`keyless@distroless.iam.gserviceaccount.com` and `https://accounts.google.com`.
Certificate, claims and transparency-log verification passed without bypass flags.
The Cosign binary came from the official immutable release and matched its
published SHA-256 asset digest.

Both official Node checksum signatures passed `gpgv` against release key
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`, listed by
[Node release keys](https://github.com/nodejs/release-keys). The linux-x64 archive
SHA-256 is `1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce`.
A read-only, network-disabled probe of the pulled Distroless base recorded UID
65532, Node 22.23.4 and OpenSSL 3.5.9. Its actual Node ELF SHA-256
`94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`
is byte-identical to that signed archive's executable. The host's similarly
versioned Node executable has different bundled libraries and was not used as
this vendor-identity proof.

## Fixed inputs and remaining findings

- Node's bundled OpenSSL is 3.5.9, the
  [29 September advisory's](https://openssl-library.org/news/secadv/20260929.txt)
  fixed release for the affected 3.5 branch. This addresses the old bundled
  3.5.8 CVE-2026-35189 code; Debian system libssl is a separate component.
- Fastify is exactly 5.12.6, fixing
  [GHSA-389g-gv7q-r4x8](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8).
  The public npm registry records publication on 13 October at 06:50:58.498 UTC,
  more than seven days before this change. Dependency ranges of that patch match
  5.12.5. No dependency-age exception, audit threshold or exclusion was added.
- The actual base contains `ca-certificates 20250419+deb13u1`, replacing the
  previously reported `20250419` package under
  [DSA-6572-1](https://security-tracker.debian.org/tracker/DSA-6572-1).
  Trust inventory and real TLS-client acceptance still need verification on
  the application image.

The same base still contains `libc6 2.41-12+deb13u4`, `libssl3t64
3.5.7-1~deb13u3` and `zlib1g 1:1.3.dfsg+really1.3.1-1+b1`. The current stable
Debian trackers still mark
[glibc CVE-2026-77117](https://security-tracker.debian.org/tracker/CVE-2026-77117),
[glibc CVE-2026-80489](https://security-tracker.debian.org/tracker/CVE-2026-80489)
and [zlib CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091)
as unresolved. Their existing caller/configuration assessments and limits remain
applicable only where reverified. No unstable libc transplant, hidden component
removal, scanner suppression or severity downgrade is part of this change.
Node's bundled zlib and Sharp's bundled zlib-ng/libpng remain separate vendor
assessments; a zero gateway scan cannot clear them.

## Additional dependency audit — 24 October

A fresh unchanged audit also reports HIGH
[GHSA-mrhx-c7xc-m3w5](https://github.com/colinhacks/zod/security/advisories/GHSA-mrhx-c7xc-m3w5).
Zod 4.6.6, published on 11 October, fixes early rejection of oversized constrained
arrays, sets and maps. It does not impose a new limit on unbounded collections.
There is no maintained v3 backport; `zod/v3` in the v4 package still retains the
older parsing implementation and is not used as the remediation.

The source resolves Zod 4.6.6 within existing transitive parent ranges. MCP now
uses its v4 API, with the required two-argument string-keyed record. MCP SDK
1.32.1 already supports v4 schemas through its native v4 conversion route and is
unchanged. The unchanged zod-to-json-schema 3.25.2 remains for the SDK's separate
v3 compatibility route; it is not used to convert this source's v4 schemas.
Existing stdio tests inspect the eleven advertised tool schemas and exercise
guarded writes and conflicts. Full eleven-tool and rich-recipe behavior remains
part of the pending installed-package smoke acceptance.
The advertised v4 JSON Schema differs: UUID constraints and string record keys
are explicit, and the SDK omits the previous top-level `additionalProperties`
metadata; runtime unknown-key stripping remains. Future public MCP remediation
requires a new immutable version, not replacement of the released 0.4.2 archive.

The same audit also reports body-parser, Nodemailer and fast-uri findings whose
fixed versions are younger than the configured seven-day age floor. Those four
exact age exceptions are proposed separately and have not been applied; the
remaining audit rows and formal release gate stay visible.

## Acceptance boundary

The runtime base proof above is complete. Application builds and their full
existing native/TLS/compatibility/routing/clean-stack restore and fresh scan
acceptance are pending on the final reviewed candidate. The API and worker must
run the same immutable image. Keep all scan severities and unresolved records;
passing ordinary TLS or SVG fixtures does not establish absence of a native
vulnerability. The historical residual ledger is retained under its original
image/source identities, rather than rewritten to describe a new image. Retained
bundles replay with their own bundled verifier. The current verifier rejects
an explicitly declared older `node22` base; no older manifest is rewritten.

Formal VARD-6 artifact acceptance and unresolved material vendor findings remain
release gates. No tag, GitHub release, npm publication, registry push or production
rollout is authorized by this dated input assessment alone. See the
[portable candidate procedure](server-release.md).
