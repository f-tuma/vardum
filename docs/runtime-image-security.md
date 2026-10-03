# Runtime image checks

Checks apply to the actual API, worker and gateway images used by each successful
disposable production test. They supplement `pnpm audit`; neither check certifies
that every native binary or runtime is free of vulnerabilities.

## Pinned inputs

Verified against official catalogs on 3 October 2026:

| Input | Official index digest | Linux/amd64 manifest |
| --- | --- | --- |
| Nginx 1.30.5 Alpine | `sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94` | `sha256:8f84ed99befc3891b8f329c5c202785278a2cfb7c25107d57fb2a134a3117433` |
| Node 22.23.3 Bookworm slim (build only) | `sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c` | `sha256:25330af3531fb5e23318554a0aa911125b6e91b1b777edf7655501d207c067a2` |
| Distroless Node 22 Debian 13 nonroot (runtime, Node 22.23.3) | `sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c` | `sha256:7b0a2b9262b3d1d57e139e08fe11bccb0a7d426ca515eab0cd6abcaf2016ae5c` |
| Trivy 0.75.0 | `sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa` | `sha256:9db099105405c648166e6b94155eb32f8da12673cf1f455207f7385cc9a77283` |

The index, platform manifest, application image ID and exported archive hash are
separate identities. Reports record the live container image ID, platform and
RootFS, export that ID and hash the exact export before scanning it. API and
worker must use the same image. Acceptance is limited to linux/amd64.

Sources: [Nginx official images](https://github.com/docker-library/official-images/blob/master/library/nginx),
[Node official images](https://github.com/docker-library/official-images/blob/master/library/node),
[Node 22.23.3 release](https://nodejs.org/en/blog/release/v22.23.3),
[Distroless supported images and signature verification](https://github.com/GoogleContainerTools/distroless),
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
`api-runtime.json` and `worker-runtime.json` record `process.versions`,
`sharp.versions`, UID, effective/bounding capabilities and NoNewPrivs for both
the probe and application PID 1. They inventory inherited tools and development
packages, system/Node CA certificates, timezone files and a fixed UTC/Prague
conversion, installed font files and ordinary SVG text rasterization. CA parsing
is not an outbound TLS handshake; text output must be compared with the saved
baseline rather than assuming fonts are installed. Nginx and OS reports record
the running native environment. Migration image identity, successful exit and
container capability/security settings are also required. `gateway-config/` contains the
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
build-stage package managers remain available. At this historical checkpoint,
an attempted optional
`better-auth@1.7.1>drizzle-kit` override was reverted: pinned pnpm 12.4.2 retained
the peer toolchain. That deployed image retained the esbuild findings.
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


## VARD-53 minimal runtime candidate: 3 October 2026

The candidate uses the maintained official Distroless Node 22 Debian 13 nonroot
runtime above, while retaining the pinned Bookworm Node build stage. Public
registry metadata identifies Node 22.23.3 and the linux/amd64 manifest shown
above; the index was uploaded on 1 October. The image config's epoch creation
time is reproducible-build metadata, not its publication date. It uses the
glibc/C++ runtime family required by the existing Node and Sharp Linux binaries;
complete ABI and deployed compatibility still require rebuilt-image acceptance. A Debian 13 version label alone does not dispose of glibc or other
remaining findings.

Before changing the runtime input, Cosign 3.1.3 verified the exact index with the
[Distroless vendor identity](https://github.com/GoogleContainerTools/distroless#how-do-i-verify-distroless-images):

```sh
cosign verify \
  gcr.io/distroless/nodejs22-debian13@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c \
  --certificate-oidc-issuer https://accounts.google.com \
  --certificate-identity keyless@distroless.iam.gserviceaccount.com
```

Verification validated the signature/claims, certificate chain and offline
transparency-log claims, with no verification bypass flags. The temporary
`cosign-linux-amd64` binary came from the
[official v3.1.3 release](https://github.com/sigstore/cosign/releases/tag/v3.1.3).
Its SHA-256 was
`4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71`,
matched both the release API digest and official checksum file before execution,
and its release Sigstore bundle verified with the documented
`keyless@projectsigstore.iam.gserviceaccount.com` identity and Google issuer.
That tool bootstrap relies on official HTTPS release metadata; it is separate
from the subsequent runtime signature verification. Repeat verification for
any replacement input.

The root [supported pnpm readPackage hook](https://pnpm.io/pnpmfile) removes only
Better Auth **1.7.1**'s optional Drizzle Kit peer metadata. The API retains its
direct development Drizzle Kit dependency for schema generation; production
migrations use checked-in SQL through Drizzle ORM and the declared pg-boss CLI.
The exact-version hook must be reassessed when Better Auth changes. No declared
binary is deleted after deployment. A dedicated nonlegacy deploy experiment
still included Drizzle Kit; the hook fixes the declared graph under the existing
legacy production deployment path instead.

Pinned pnpm 12.4.2 regeneration changed only that package's peer metadata,
affected peer contexts and the hook checksum. Package keys, importer versions
and specifiers stayed unchanged. A frozen installation passed the unchanged
seven-day age, trust and build policies. Host API build, workspace type checks
and both Better Auth/Drizzle schema generators passed. The host production
deployment contained no Drizzle Kit, esbuild, @esbuild or @esbuild-kit packages;
Sharp 0.35.5 and its optional Linux native packages remained present. These are
host graph checks, not a scan or acceptance result for the rebuilt image.

The Dockerfile clears the vendor Node entrypoint so existing `node` commands
start once, adds `/nodejs/bin` to PATH and uses numeric UID/GID 65532 with matching
application ownership. Production and both Dokploy templates drop all
capabilities and enable `no-new-privileges` for migration, API and worker. The
[Linux no_new_privs contract](https://www.kernel.org/doc/html/latest/userspace-api/no_new_privs.html)
bounds setuid/setgid/file-capability gains across exec; it does not assess host
kernel issues or every possible privilege transition. Gateway retains its
existing startup policy. API probes use Node filesystem reads and tolerate an
absent `/opt`; no shell or `cat` is required in the minimal application image.

**Candidate acceptance and release disposition remain pending.** Rebuild the
actual final images and run the full disposable production smoke, migrations,
RLS, SVG/AVIF, public CLI/MCP, outage/backpressure, large POST, restore and all
three gateway routing configurations. Verify API/worker health commands and
signals, numeric ownership, CA/default-trust HTTPS and timezone behavior; compare
ordinary SVG text/font output against the saved baseline without adding fonts
merely to satisfy a test. Require actual PID 1 and probe NoNewPrivs=1,
CapEff=0/CapBnd=0 and matching migration container policy. Export the exact images,
scan with a fresh database and retain complete OS/Node/native inventories and
hashes. Reconcile every baseline residual with actual component absence, a
specific conditional call-path assessment or unresolved impact. Keep bundled
libpng 1.6.58 and Node/nghttp2 assessment separate; fewer scanner records alone
are not evidence that a retained library is patched. Independent reviews,
current exact-source CI and VARD-6 clean artifact/provider acceptance remain
required before release.


### Rebuilt candidate acceptance: 3 October 2026, 18:20 UTC

The complete local dirty-source check used staged source tree
`7602e79666ebeb374c13d16c294f0e74c69d7845` above merged main `c38b9fb0`.
Frozen installation, 164 unit/script tests, type checking, lint, build and all
three Compose configuration checks passed. The deployed acceptance passed
public CLI 0.6.0/MCP 0.2.0 onboarding and authentication, actual service outages
and worker recovery, resource rejection/recovery, a 3,512,199-byte image POST,
clean-stack backup/restore of 28 objects / 11,351,680 bytes, SVG/AVIF/RLS and all
87 gateway routing assertions. The normal Dockerfile API command and Compose
worker/migration/health commands ran without a shell. Docker events recorded
SIGTERM (15) and exit 0 for the actual API and worker during final cleanup;
intentionally killed routing-helper containers are separate events.

API and worker use the same actual image
`sha256:b28cb643aa4b851a1eb8d1e76e80794d7952f8dcd0c38fe9cf14ebbf98cd3987`.
Gateway image is
`sha256:57f892e73f4f015c7896ab0a05beba8aeb97d78533c310698182be9e46a67f10`.
API and worker PID 1 and probe processes had UID 65532, NoNewPrivs 1 and zero
effective/bounding capabilities. Migration used the same image, completed with
exit 0 and had matching cap-drop/security options. No inherited package managers
or Drizzle/esbuild packages were found in the production runtime. The tested
resolver had one search domain, maximum length three, and no LOCALDOMAIN.
These are tested container conditions, not evidence for a provider's resolver.

Identical fixtures in the saved previous image and this image produced identical
PNG/JPEG/WebP/AVIF decoded pixels, SVG text pixels and UTC/Prague/New York time
zone results. Both images have no installed system fonts and emit the same
Fontconfig warning; the unchanged fallback text is not a font-quality or general
typography guarantee. The new image passed HTTPS certificate verification to
one public npm endpoint using both default Node trust and its system CA bundle
(150 system certificates, 119 Node bundled roots). This does not establish an
external SMTP provider's TLS compatibility.

The freshly downloaded Trivy database was updated at
`2026-10-03T14:28:08.788288516Z`, downloaded at `18:20:16Z`, and its SHA-256 is
`43bf9c31bd79ea3a98f7b467c1d4cfe87cdbc4f7939654fedc76a9350dcfceb4`.
The complete unfiltered scan reports **31 API OS package records** (23 medium,
eight low), with 14 Debian 13.7 OS packages inventoried and 185 Node packages
with no reported findings. Gateway has no reported findings. Remaining records
include glibc 2.41-12+deb13u4, GCC runtime 14.2.0-19 and zlib 1.3.1; reduced counts
do not establish that these components are patched.

| Evidence | SHA-256 |
| --- | --- |
| API export | `e3c9fdcb336410a37ce025afaf6fb7d4b17a7bcb9d168d847c393d4f2303faec` |
| API raw scan | `5e045ed4da8d0bdba2b71aa35ed60b333ded12441922c1985454227500c1f40e` |
| Gateway export | `006353e4ab6ed6272f94546f75016248e6494dfd1364f4a40c510f61a42a47de` |
| Gateway raw scan | `e13bfa02529c2dd11930175d1313195a8b88fa3334b170fbe96042ac6f09d790` |
| Runtime evidence | `bb09494e95593c4b5ec2f4212020e56210bc402307b750c4bd6639251b42cd7f` |

**Residual record disposition, final independent review, exact-head CI and the
clean VARD-6 portable artifact remain pending.** These successful local checks
are not a release or production deployment approval. Raw records, exact image
exports and the scanner database remain available locally for independent
assessment; CI retains only the approved JSON/text evidence.
