# Runtime image checks

Checks apply to the actual API, worker and gateway images used by each successful
disposable production test. They supplement `pnpm audit`; neither check certifies
that every native binary or runtime is free of vulnerabilities.

## Pinned inputs

Verified against official catalogs on 3 October 2026:

| Input | Official index digest | Linux/amd64 manifest |
| --- | --- | --- |
| Nginx 1.30.5 Alpine | `sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94` | `sha256:8f84ed99befc3891b8f329c5c202785278a2cfb7c25107d57fb2a134a3117433` |
| Node 22.23.3 Bookworm slim | `sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c` | `sha256:25330af3531fb5e23318554a0aa911125b6e91b1b777edf7655501d207c067a2` |
| Trivy 0.75.0 | `sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa` | `sha256:9db099105405c648166e6b94155eb32f8da12673cf1f455207f7385cc9a77283` |

The index, platform manifest, application image ID and exported archive hash are
separate identities. Reports record the live container image ID, platform and
RootFS, export that ID and hash the exact export before scanning it. API and
worker must use the same image. Acceptance is limited to linux/amd64.

Sources: [Nginx official images](https://github.com/docker-library/official-images/blob/master/library/nginx),
[Node official images](https://github.com/docker-library/official-images/blob/master/library/node),
[Node 22.23.3 release](https://nodejs.org/en/blog/release/v22.23.3),
[Trivy 0.75.0 release](https://github.com/aquasecurity/trivy/releases/tag/v0.75.0).

## Evidence and replay

`bash scripts/smoke-production.sh` runs full disposable acceptance followed by
`scripts/check-runtime-images.mjs`. Set `SMOKE_IMAGE_REPORT_DIR` to a new,
nonexistent directory to choose where evidence survives stack cleanup.

The scanner has no Docker socket. It downloads its vulnerability database, then
scans exports with networking disabled, a read-only root, unprivileged UID,
dropped capabilities and isolated temporary storage. OS detection and package
inventory are required. Reports retain all severities and unfixed findings;
no blanket exclusions are used. Scanner or inventory failure marks evidence
incomplete and fails the smoke.

`runtime-evidence.json` records invocations, source commit and dirty state,
image identities, archive/report hashes, scan time, database metadata and hashes.
`api-runtime.json` records `process.versions` and `sharp.versions`. Nginx and OS
reports record the running native environment. `gateway-config/` contains the
normal-entrypoint, envsubst and HTTP checks for standard, marketing and loopback
fallback configurations. SIGINT/SIGTERM abort active probes, clean up only the
invocation's labelled resources, retain interrupted evidence and exit nonzero.
SIGKILL or host failure cannot run cleanup; use the recorded owner/network to
inspect and remove only that invocation's remaining resources.

PR/main CI and release validation retain JSON/text reports as
`runtime-image-evidence` for seven days.
It does not upload application image archives or the database snapshot.
Consequently, downloaded CI reports establish recorded findings and identities,
not a self-contained offline replay. The local evidence directory keeps the
exports and exact database for replay; preserve these locally when needed.

For local replay, verify the recorded archive and database hashes, then use the
recorded scanner digest and unchanged evidence directory:

```sh
docker run --rm --read-only --network none \
  --user "$(id -u):$(id -g)" --cap-drop=ALL \
  --security-opt=no-new-privileges --tmpfs /tmp \
  --mount "type=bind,src=$PWD/evidence,dst=/evidence,readonly" \
  aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa \
  image --cache-dir /evidence/cache --cache-backend memory --skip-db-update \
  --skip-java-db-update --offline-scan --scanners vuln \
  --list-all-pkgs --format json --input /evidence/api.tar
```

Repeat for `gateway.tar`. Keep the original raw report. Replay does not make an
old database current; each fresh candidate requires a fresh online database.

## Gateway routing proof

The disposable probes use the tested immutable images with their normal inherited
entrypoint. Each of the standard, marketing and loopback fallback configurations
must pass nginx validation and 29 HTTP assertions, including exact static bundle
bytes, every SPA route prefix, API/delivery/health routing, legacy assets,
forwarded headers and method/body/query preservation.

The marketing template explicitly serves `/index.html` as a static file. A SPA
`try_files` fallback internally redirects there; without the exact location, the
catch-all marketing proxy incorrectly receives `/app` and other application
routes. The probe verifies both direct index requests and SPA fallback behavior,
while the apex and unrelated marketing paths still reach the marketing backend.

## Vendor assessment and release gate

A completed scan means the scanner executed and inventoried the images. Assess
each relevant finding as fixed, absent from the effective configuration with
specific evidence, or unresolved with impact and follow-up. Do not publish with
unresolved material findings.

Nginx 1.30.5 is outside currently version-fixed ranges in the
[Nginx advisory table](https://nginx.org/en/security_advisories.html).
CVE-2009-4487 remains a version-independent logging limitation with no fixed
version. Effective configs need separate assessment; compiled module presence
does not establish use. Supplied configs do not terminate TLS or enable HTTP/2,
HTTP/3, mail, stream, DAV, MP4, SSI or slice handlers. Other deployment configs
need their own assessment.

OS package detection does not cover the upstream Node executable in the official
image or every bundled native codec. Check recorded versions against vendor
release/security notes as well. The
[30 September Sharp librsvg advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)
was not yet reported by npm audit on 3 October. The API now pins Sharp 0.35.5.
The deployed check requires stable numeric versions of Sharp >= 0.35.5,
librsvg >= 2.63.2 and libheif >= 1.23.5, prints the full codec inventory, and
verifies ordinary SVG rasterization and AVIF encode/decode. The
[1.3.4 native bundle](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4)
contains the patched libraries; libheif 1.23.5 also fixes the
[coded-dimension allocation issue](https://github.com/strukturag/libheif/security/advisories/GHSA-v8qw-hwjv-44hw)
and 1.23.4 fixes the earlier
[item-count limit bypass](https://github.com/strukturag/libheif/security/advisories/GHSA-vg7w-rp49-4fc2).
Neither ordinary codec checks nor an older zero-audit result establish absence
of every native issue.

The seven-day dependency release-age gate and supply-chain policy remain enabled.
The security update has 27 exact version exceptions for Sharp 0.35.5 and its
platform packages/native bundle 1.3.4, published 27 September. These do not allow
future versions to bypass the gate. Reassess native vendor advisories even when
npm audit returns no findings.

Digest pins do not receive later patches automatically. Before each release,
check official catalogs and vendor advisories, scan fresh images, update pins
and native packages as necessary, rerun acceptance and obtain independent review.
Keep versions, date, findings and exact candidate identity with release evidence.
External-provider, deployment, capacity and human first-use acceptance remain
separate requirements.

## Assessment checkpoint: 3 October 2026

The first full patched-codec acceptance used API/worker image
`sha256:1d0f7c384060427e7697b96c7c7b13a976c6c5db4bbf0e6f5d4a434938fecb1f`
and gateway image
`sha256:cf14a194a797de353073d5cc56379728af3e35be52777f9c7512665b57fbd6c2`.
It passed public CLI 0.6.0/MCP 0.2.0 acceptance, SVG/AVIF/RLS, recovery of 28
objects and all 87 routing assertions. Trivy 0.75.0 with a database updated at
2026-10-03T14:28:08Z reported **302 API package findings** (236 Debian, 20
inherited npm, 46 development esbuild/Go) and **four gateway findings**.
Those counts are historical inputs to the following changes, not results for
the final rebuilt image.

The gateway installs four exact fixes from the official Alpine 3.24 package
index: libexpat 2.8.5-r0, libpng 1.6.59-r0, nghttp2-libs 1.70.0-r0 and pcre2
10.49-r0. The API runtime removes inherited npm/npx, Corepack and Yarn;
build-stage package managers remain available. An attempted optional
`better-auth@1.7.1>drizzle-kit` removal was reverted: pinned pnpm 12.4.2 retained
the peer toolchain. The deployed esbuild findings therefore remain for review.
Sharp's optional native packages and supply-chain controls remain enabled.

The runtime probe records non-root UID, effective capabilities, absence of the
removed tools and resolver search-domain lengths without publishing DNS servers
or search-domain text. It rejects root or CAP_SYS_ADMIN application processes.
These conditions bound the tested container; they do not assess a different
provider's host configuration or arbitrary privileged deployment.

Specific vendor applicability established for the first saved image:

- [MiniZip CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853):
  Debian explicitly does not build the affected MiniZip component into Bookworm
  zlib. No MiniZip component was found in the saved image.
- [Perl CVE-2026-8376](https://security-tracker.debian.org/tracker/CVE-2026-8376)
  requires 32-bit Perl; the saved ELF64/x86-64 binary and Perl configuration use
  eight-byte pointers/integers.
- Archive::Tar (CVE-2026-42496/42497/9538), IO::Compress
  (CVE-2026-48962), Storable (CVE-2026-57433) and systemd-homed
  (CVE-2026-16742) components were absent from the saved image. Their aggregated
  source-package records remain visible in the report.
- Perl regex/pack, mount/nsenter, gzip, ACL and ncurses findings require a weaker
  disposition: affected tools or libraries remain, although checked production
  API paths do not invoke them. In particular, the
  [Perl CVE-2026-13221 record](https://security-tracker.debian.org/tracker/CVE-2026-13221)
  marks 5.36 affected while noting introduction in 5.37.10. That contradiction
  is unresolved; do not label the binary patched.
- [glibc CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435)
  and [CVE-2026-6238](https://security-tracker.debian.org/tracker/CVE-2026-6238)
  concern deprecated DNS debug-print functions, rather than ordinary resolver
  processing. [CVE-2026-8674](https://security-tracker.debian.org/tracker/CVE-2026-8674)
  concerns long search domains in LOCALDOMAIN/resolv.conf configuration;
  actual provider configuration still needs assessment.

The native bundle contains **libpng 1.6.58**, not the patched 1.6.59. The
[libpng advisory GHSA-qvg3-h654-xq3j](https://github.com/pnggroup/libpng/security/advisories/GHSA-qvg3-h654-xq3j)
requires a caller to reach `png_read_end` after `png_read_info` without the
intervening initialization/read calls. The checked
[libvips 8.18.7 PNG loader](https://github.com/libvips/libvips/blob/v8.18.7/libvips/foreign/vipspng.c)
initializes reading and explicitly avoids `png_read_end`; that specific call
path lacks the advisory's precondition. This is not a patched-libpng claim or
assessment of every other possible caller. Likewise, Node's bundled nghttp2
must be assessed separately from the affected nghttpx proxy component.

The rebuilt hardening checkpoint completed at 2026-10-03T17:24:17Z:
API/worker image
`sha256:6926499776ecac0fdeed73bd0b6fe54be6f28bf91ec45398e2f3150654ce1052`
and gateway image
`sha256:7b09c8b743d75c62b2d4027bcf9b7caadb7320e858dfd27dae3758aa11cc907b`.
Full acceptance passed again, including all 87 routing assertions and recovery
of 28 objects / 11,344,608 bytes. Freshly downloaded Trivy DB SHA-256 was
`43bf9c31bd79ea3a98f7b467c1d4cfe87cdbc4f7939654fedc76a9350dcfceb4`.
The report contains **282 API findings** (236 Debian, 46 esbuild/Go) and **zero
gateway findings**, with OS/package inventory present. The 199-package Node.js
inventory has no reported findings; bundled native vendor checks remain separate.
Both application processes use UID 1000, effective capabilities zero, no removed
package managers, a longest resolver search domain of three characters and no
LOCALDOMAIN. This is local dirty-source acceptance, not the clean VARD-6
artifact or a provider deployment, and zero gateway findings do not certify
absence of every gateway vulnerability.

**Release remains held.** Planner VARD-53 tracks residual OS/native
applicability and a minimal-runtime/base-image comparison, including all
remaining relevant report records. Current vendor records offer no Bookworm
fix for the 19 unique HIGH/CRITICAL OS IDs; switching to Trixie alone does not
resolve all util-linux, ACL, ncurses and Archive::Tar findings. Fresh rebuilt
image evidence, independent review and current CI are required for this patch;
VARD-6 additionally requires clean artifact acceptance and disposition of
material residual findings. No new npm/server publication or provider deployment
is established by this checkpoint.
