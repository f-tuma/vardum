# API and worker zlib assessment — 10 October 2026

CVE-2026-85091 remains unresolved in the reviewed API/worker image. No implicated
gzip file-writer caller was identified in the checked service paths. This is a
bounded caller assessment, not a fix, scanner suppression, exploit exclusion or
public-release clearance. VARD-74 tracks remediation; VARD-6 still requires the
final saved-artifact and provider acceptance.

## Exact candidate and component boundaries

Evidence applies to linux/amd64 API and worker image
`sha256:3b3ca89ed4ba61973c8dbf0aec4e76d83ebbeca20513fa48e723ea59c42f44a9`,
built in the VARD-73 local production run. Its retained export SHA-256 is
`896e60ed57c0d06e57b1912fee32da4989a5de38b9bd5c58bec4846e735bc54d`;
the OCI config is
`c6b7aea263ed6870a10636e0005e30e5d670e94d3301ce91c2c79bb82e0a9a4c`.
This is the local implementation image, not an inspected production deployment
or the future clean portable bundle.

| Implementation | Installed version and observed code | Disposition |
| --- | --- | --- |
| Debian system zlib | `zlib1g 1:1.3.dfsg+really1.3.1-1+b1`; installed library matches the current stable amd64 vendor package | Vendor marks affected; no fixed stable version found. Preserve the MEDIUM scanner record. |
| Node bundled zlib | Node `22.23.3`, `process.versions.zlib` `1.3.1-e00f703`; actual executable contains gzip file-writer and error-reset functions | Separate older implementation; no proof it is fixed or unaffected. Checked JavaScript compression binding uses memory compression, not gzip file APIs. |
| Sharp bundled zlib-ng | Sharp `0.35.5`, native bundle `1.3.4`, libvips `8.18.7`, zlib-ng `2.3.3`; static dependency compiles gzip-file support | Separate older implementation; no vendor unaffected conclusion established. Hidden/stripped symbols do not prove writer exclusion or unreachable static code. |

The actual system `libz.so.1.3.1` SHA-256 is
`85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e`.
The Debian, upstream v1.3.1 and Node v22.23.3 `gzwrite.c` files are byte-identical,
SHA-256 `469b1e58932ea11bdda2a153f6655f7b3c13254240fae157181b49ed1bc93b47`.
The actual bundled libvips ELF SHA-256 is
`4aa73553408c3964071728f4a231a8e86918e39bc49f1fbae75355f7ea933ea9`.

The image inventory inspected all 286 ELF files. The only declared
`DT_NEEDED libz.so.1` consumer is system `libcrypto.so.3`, whose zlib imports are
memory `deflate`/`inflate` operations and their initialization/end functions.
Node, the Sharp addon and bundled libvips do not declare dependencies on system
libz, libcrypto or libssl. This separates the implementations and bounds declared
dynamic consumers; it does not rule out indirect loading or hidden static code.
The Alpine fixes in [the gateway assessment](runtime-image-security.md#vard-73-gateway-alpine-package-fixes-10-october-2026)
do not repair any of these API/worker implementations.

## Why the older versions remain unresolved

The [Debian tracker](https://security-tracker.debian.org/tracker/CVE-2026-85091)
marks the installed source version vulnerable. The
[stable amd64 catalog](https://packages.debian.org/trixie/amd64/zlib1g) still lists
the installed binary version. Although the published description names a newer
nonblocking implementation range, [Debian's 5 October response](https://bugs.debian.org/1146895#50)
declines a not-affected classification pending upstream scope clarification.

The newer reported scenario involves a gzip file writer, a nonblocking descriptor
that fails with `EAGAIN`/`EWOULDBLOCK`, retained external input after a direct
`gzwrite`, and a later small or formatted write. The
[older-path upstream discussion](https://github.com/madler/zlib/issues/1292#issuecomment-5978051928)
also describes retained external `next_in`/`avail_in` after a write failure:
`gzclearerr()` clears the sticky error without resetting those pointers. A later
write can then reuse stale state. This older sequence need not use nonblocking
I/O. Missing newer `gz_vacate`/`state->again` functions or a sticky error before
it is cleared cannot establish that the older code is unaffected.

Memory compression via `deflate`/`inflate`, compressed input and HTTP backpressure
alone do not establish this gzip file-writer sequence. The
[accepted upstream fix](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)
resets retained external input after the failed direct write. An independent
`patch --dry-run --batch --fuzz=0` check of the exact Alpine backport succeeded
against upstream v1.3.2 but failed against Debian v1.3.1, Node's bundled source
and zlib-ng 2.3.3. Older sources require a separately adapted and validated fix;
this patch cannot be described as a mechanical vendor update for them.

## Sharp supplier evidence and limits

The native bundle's registry metadata and decoded publish/provenance attestation
identify source commit `ebb95f8add54eee8bed840e3fb587e4cbec857d7`; the attestation
subject SHA-512 matches registry integrity and the actual image's frozen lock.
This is consistency evidence, not independent cryptographic attestation or
transparency-log verification. The supplier versions file matches the recorded
native versions.

The [exact supplier build](https://github.com/lovell/sharp-libvips/blob/ebb95f8add54eee8bed840e3fb587e4cbec857d7/build/posix.sh)
selects static zlib-ng with `ZLIB_COMPAT=TRUE`. The
[zlib-ng 2.3.3 configuration](https://github.com/zlib-ng/zlib-ng/blob/2.3.3/CMakeLists.txt#L184)
forces `WITH_GZFILEOP=ON` for that option. The supplier subsequently hides archive
symbols and strips output. Thus gzip-file support was compiled into the static
dependency; whether writer objects survive final linking into the bundle is not
established by the absence of public symbols. The supplier build SHA-256 is
`333031b3b49bf1a16d0b9d6812d98f67c404218932ef8c0b389388524a524b36`;
the zlib-ng CMake file SHA-256 is
`095dfb3b21c4402d39cfc1e928893d2ffc53713ea897048617818a7a8b6eaec9`.

## Checked service paths

Both repository source and the image's compiled service files were inspected:

- Worker ingest passes file bytes to `sharp(bytes).metadata()`.
- API image variants pass bytes to Sharp, choose PNG/JPEG/WebP/AVIF and call
  `toBuffer()`; they do not request compressed file-descriptor output.
- Original delivery streams the S3 response body. Object backup copies bytes to
  content-hashed `.bin` files through ordinary Node file streams.
- No application source or compiled service module references Node zlib or
  native gzip file-writer/error-reset APIs. The
  [Node JavaScript zlib binding](https://github.com/nodejs/node/blob/v22.23.3/src/node_zlib.cc)
  calls memory compression operations. Binary inspection identified no external
  direct caller of Node's gzip writers; indirect/native calls remain a limit.
- Host backup orchestration runs `pg_dump -Fc` and `pg_restore` in the separate
  PostgreSQL container. PostgreSQL compression and host release archive gunzip
  belong to their own component inventories, outside this API/worker assessment.

These facts support only “no implicated writer caller identified in the reviewed
API/worker paths.” No malformed payload, error-injection exploit or production
mutation was executed. Ordinary native/TLS/restore smoke proves functionality,
not absence of this issue.

## Remediation and review triggers

At the checked date, Debian stable has no fixed version, the
[Node release index](https://nodejs.org/dist/index.json) still lists installed
22.23.3 as the latest 22.x, and the
[zlib-ng latest release](https://github.com/zlib-ng/zlib-ng/releases/tag/2.3.3)
is the installed 2.3.3. No supported vendor-fixed API/worker target was identified.
A fresh distroless rebuild with unchanged component versions is not evidence of
a repair.

Keep remediation open. When a supported candidate is available, verify the actual
repair separately in Debian zlib, Node bundled zlib and the Sharp supplier build,
then rebuild and scan both API/worker images and rerun native, TLS, backup/restore
and installed-client acceptance with independent review. A deliberately maintained
source backport would require its own plan and regression validation of the
write-failure/error-reset path; the literal newer patch is insufficient. Preserve
all findings and do not transplant unstable ELFs or remove package metadata.

Reopen caller review on any image/component/platform digest change, new native
addon or codec plugin, gzip file output/error recovery, buffer-to-file/descriptor
output change, or service-command change. VARD-74 remains an unresolved
remediation even after this assessment is reviewed. Existing instance-specific
LOW OpenSSL deployment consent does not cover this MEDIUM finding or public
release.

Official metadata/source snapshots retain fetch times, sizes and SHA-256 hashes;
local ELF and compiled-file manifests retain the checked candidate association.
Full image exports and the scanner database remain local. This documentation
records the evidence and limits without publishing those archives.
