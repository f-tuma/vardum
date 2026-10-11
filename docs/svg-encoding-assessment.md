# VARD-54 SVG encoding and charset evidence

Assessment checkpoint: 10 October 2026, linux/amd64. **CVE-2026-77117 and
CVE-2026-80489 remain open and unpatched in the assessed API/worker image.**
The evidence narrows the checked upload caller and records configuration;
it does not suppress either finding, establish native buffer safety, or clear
the image for release. The earlier
[residual ledger](runtime-residual-assessment-20261003.json) remains historical
evidence for its own image. This checkpoint binds the separate image below.

## Actual image and retained evidence

| Input or component | Identity |
| --- | --- |
| API/worker image | `sha256:3b3ca89ed4ba61973c8dbf0aec4e76d83ebbeca20513fa48e723ea59c42f44a9` |
| Local archive `/tmp/vardum73-runtime-public-oct10/api.tar` | SHA-256 `896e60ed57c0d06e57b1912fee32da4989a5de38b9bd5c58bec4846e735bc54d` |
| Archive image configuration | SHA-256 `c6b7aea263ed6870a10636e0005e30e5d670e94d3301ce91c2c79bb82e0a9a4c` |
| Debian `libc6` | `2.41-12+deb13u4` |
| `usr/lib/x86_64-linux-gnu/gconv/SHIFT_JISX0213.so` | 22,664 bytes; SHA-256 `b365d330945888688970188f33a3fa34ff9eb2303110d31ab354dca8dd56714d` |
| `usr/lib/x86_64-linux-gnu/gconv/EUC-JISX0213.so` | 22,664 bytes; SHA-256 `e5fc7cc8db10482f2c53e7a7287e88b10f070d41dea488a9d9473b525dc98166` |
| Actual `app/dist/asset-processor.js` | SHA-256 `8e0604e0de5b8e61e1e240b65ca326d2a6ddd0e050dfeeff0a442cf106b211f1` |
| Actual `app/dist/image-variant.js` | SHA-256 `c3d908aeac2644cc8fd7e65158fc97f2425ac55247585f1b2e16b4543cddbe24` |

The read-only source and selected-image investigation is retained locally in
`/tmp/vard54-readonly-oct10`; compiled application and native provenance inputs
also remain in `/tmp/vard74-plan-vendor-jty9xtfr`. The selected-image manifest
SHA-256 is `258c25e3ed118919734fb0814a9ae6d3d7fb226c4a3e8e940d9b75dca15f8df7`;
the bounded direct-caller manifest SHA-256 is
`3ae2345b2746d57a1f57c11d52b9c56eb7a0adcf8ab5694d679d9e6ab6f551af`.
Archive and raw environment data are not workflow upload inputs. These hashes
associate this local investigation; they do not make it an offline replay or
complete proof of every native caller.

## Vendor condition and remediation

Both glibc advisories describe stalled conversion from the named Japanese
encoding to UCS-4/internal wide characters when an output buffer splits a
two-codepoint sequence and the caller retries. The affected pending conversion
state is not cleared, allowing repeated output without input progress. The
upstream 2.41 branch source fixes are distinct:

| Finding | Affected converter | Upstream 2.41 source backport |
| --- | --- | --- |
| [CVE-2026-77117](https://security-tracker.debian.org/tracker/CVE-2026-77117) | `SHIFT_JISX0213` | [e43e46f94398b3de446fec11da1e7633ea5202ec](https://sourceware.org/git/?p=glibc.git;a=commit;h=e43e46f94398b3de446fec11da1e7633ea5202ec) |
| [CVE-2026-80489](https://security-tracker.debian.org/tracker/CVE-2026-80489) | `EUC-JISX0213` | [ec116a0fbedcc860631e525e70b409cf295f27da](https://sourceware.org/git/?p=glibc.git;a=commit;h=ec116a0fbedcc860631e525e70b409cf295f27da) |

Primary [glibc advisory 0019](https://sourceware.org/git/?p=glibc.git;a=blob;f=advisories/GLIBC-SA-2026-0019)
and [advisory 0020](https://sourceware.org/git/?p=glibc.git;a=blob;f=advisories/GLIBC-SA-2026-0020)
are retained in the local source investigation. The installed Debian source
package and patch series do not include these fixes. On 10 October the Debian
tracker still marks trixie `2.41-12+deb13u4` vulnerable for both; it identifies a
fixed unstable version, without identifying a fixed stable trixie binary.
Upstream branch commits are source backports, not installed Debian updates.
Both affected modules remain in the actual image.

The remediation requirement is an authenticated maintained runtime/base artifact
with both fixes, followed by exact-image verification and the existing runtime
acceptance. A local source patch, an unrelated distribution's package, or a
passing fixture is not evidence of that binary result. No libc transplantation,
image change, exploit execution, native FFI, or arbitrary-offset native call is
part of this evidence work.

## Checked SVG and native callers

The actual compiled asset processor and variant generator supply upload/object
Buffers to Sharp. Their repository sources are
[asset-processor.ts](../apps/api/src/asset-processor.ts) and
[image-variant.ts](../apps/api/src/image-variant.ts). Sharp 0.35.5's
[Buffer dispatch](https://raw.githubusercontent.com/lovell/sharp/v0.35.5/src/common.cc)
selects the Buffer loader. The checked
[libvips 8.18.7 SVG loader](https://raw.githubusercontent.com/libvips/libvips/v8.18.7/libvips/foreign/svgload.c)
builds a memory stream and supplies a NULL base file to librsvg. Default safety
flags remain enabled; application callers do not set `unlimited`.

The exact Sharp libvips 1.3.4
[vendor build](https://raw.githubusercontent.com/lovell/sharp-libvips/v1.3.4/build/posix.sh)
sets libxml2 `minimum=true`. In libxml2 2.15.4's
[option evaluation](https://raw.githubusercontent.com/GNOME/libxml2/v2.15.4/meson.build)
and [defaults](https://raw.githubusercontent.com/GNOME/libxml2/v2.15.4/meson_options.txt),
that disables its optional iconv support. This weakens the proposed direct
uploaded-XML-declaration-to-glibc Japanese-converter path for this exact vendor
build. It does not establish that the entire native stack lacks conversion.

The retained `iconv_open` direct-call site is consistent with GLib's wrapper,
but the bounded caller manifest labels its unexported helper as unassigned.
This is a source/call-pattern interpretation, not proven exact-symbol mapping.
Known conversion selectors occur in internal GLib paths, and both checked GLib
IOChannel encoding setters pass NULL. Several other unexported helpers also
remain unassigned; nearest exported-symbol names and direct-call enumeration
cannot exclude hidden or indirect native paths. No checked application caller selecting either affected Japanese
converter from the upload was identified. Provider charset overrides, new
conversion APIs, changed vendor builds, filenames or diagnostic paths require
fresh caller assessment.

No external file/HTTP base is supplied on this Buffer loader, but embedded
`data:` resources remain permitted under
[librsvg's resource rules](https://gnome.pages.gitlab.gnome.org/librsvg/Rsvg-2.0/class.Handle.html#security-and-locations-of-referenced-files).
This is not a blanket claim that SVG parsing or embedded image decoding is safe.
GLib 2.90.0's
[conversion loop](https://raw.githubusercontent.com/GNOME/glib/2.90.0/glib/gconvert.c)
grows output storage and retries `E2BIG`; growth/retry cannot prove the vulnerable
pending-state condition is impossible. Ordinary encoding, malformed-input and
rasterization fixtures cover observed application behavior, not every native
buffer split, hidden caller or adversarial case. Input and pixel limits are
application controls, not a vendor patch or proof of native memory/CPU safety.

## Ordinary compatibility checks

The shared [SVG fixtures](../scripts/fixtures/svg-compatibility.mjs) and
[API tests](../apps/api/src/svg-support.test.ts) exercise ordinary UTF-8 and
actual ISO-8859-1 bytes. An ASCII-escaped CSS selector must match the accented
class and produce exact opaque red pixels; this checks encoding semantics
without relying on fonts. An embedded ordinary PNG must produce exact opaque
green pixels. Removing the accent match or embedded image must instead produce
the expected blue fallback, so two blank or equally wrong results cannot pass.
Metadata, bounded 64-by-32 PNG pixels and unchanged input bytes/hashes are checked.
The ordinary malformed-XML classifier runs in a child with a 15-second hard
SIGKILL deadline; the API test also verifies killing an unresponsive child.

Latin-1 is handled by libxml2's built-in
[ISO-8859-1 converter](https://raw.githubusercontent.com/GNOME/libxml2/v2.15.4/encoding.c).
Its successful conversion does not prove iconv use or Japanese-converter safety.
The fixtures do not exercise either CVE's small-output-buffer retry condition.

The [public CLI lifecycle helper](../scripts/smoke-svg-compatibility.mjs) uses
writable Vard mappings to push these original SVGs under ASCII asset keys with
non-ASCII local/output filenames preserved as filename metadata. It checks exact
original delivery bytes and SHA-256, worker/version checksums and readiness,
PNG pixels, repeated cached PNG bytes, unchanged original/input state and an
unchanged repeat push. [The smoke hook](../scripts/smoke-test.js) runs this helper
before the full-bucket backup/restore check, so those stored originals and
variants are included. The deployed codec probe also uses the shared fixture
bytes through [smoke-production.sh](../scripts/smoke-production.sh).

These are implementation and ordinary compatibility checks. This checkpoint
does not establish final reviewed-source CI or a completed new full-smoke run.
The assessed baseline image `sha256:3b3ca89ed4ba61973c8dbf0aec4e76d83ebbeca20513fa48e723ea59c42f44a9`
above is separate from any newly built full-smoke image; later acceptance must
record that image's identity and results independently. Both VARD-54 findings
remain open.

## Configuration observations and privacy boundary

Direct inspection of the hash-bound saved image configuration found zero entries
for all twelve selected charset names below. The checked environment mappings in `docker-compose.yml`,
`compose.production.yml`, `compose.dokploy.yml` and `compose.dokploy.dev.yml`
also contain no such assignments. Image/Compose
configuration does not prove the effective application environment or native
locale. In particular, the original saved smoke did not record PID 1's complete
environment, process/thread locale state or GLib charset caches; this change
does not retroactively fill that gap.

The [charset helper](../scripts/runtime-charset-evidence.mjs) adds optional
`charset` evidence to API and worker runtime inventories while retaining report
schema 1 and existing source/image association. It distinguishes two sources:

- `pid1StartupEnvironment`: `/proc/1/environ` read from the fresh exec probe,
  bounded to 65,536 bytes in total. Linux exposes the process's startup environment
  memory region; it is not a getter for all later `setenv` changes or a guarantee
  that the original region has remained unchanged. Duplicate entries, malformed
  or unterminated entries, a filled read cap and unreadable input make the whole
  observation `unknown`, with no variable claims or raw error.
- `execProbeEnvironment`: only selected own `process.env` keys from the fresh
  shell-free `docker exec ... node` process. It is separately identified from
  PID 1. Node's environment object does not preserve duplicate native entries;
  this scope does not claim duplicate detection for its original exec environment.

The only selected names are `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`,
`LC_MESSAGES`, `CHARSET`, `G_FILENAME_ENCODING`, `G_BROKEN_FILENAMES`,
`OUTPUT_CHARSET`, `GCONV_PATH`, `LOCPATH`, and `LIBCHARSET_ALIAS_DIR`.
Recorded values become `unset`, `empty`, `recognized`, or `other` statuses.
Only the following fixed harmless tokens may accompany `recognized`:

| Variable group | Publishable tokens |
| --- | --- |
| `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES` | `C`, `POSIX`, `C.UTF-8`, `C.utf8`, `en_US.UTF-8`, `ja_JP.UTF-8` |
| `CHARSET`, `G_FILENAME_ENCODING`, `OUTPUT_CHARSET` | `UTF-8`, `UTF8`, `ASCII`, `US-ASCII`, `EUC-JP`, `EUC-JISX0213`, `SHIFT_JIS`, `SHIFT_JISX0213` |
| Additional `G_FILENAME_ENCODING` token | `@locale` |
| `G_BROKEN_FILENAMES`, `GCONV_PATH`, `LOCPATH`, `LIBCHARSET_ALIAS_DIR` | Presence/empty/unset statuses only; no values or hashes |

Unrecognized and compound values, paths, other environment variables and raw
read failures are never serialized by the helper. `nativeState.processLocale`,
`nativeState.threadLocales` and `nativeState.glibCharset` are always
`not-observed`: environment variables do not establish `setlocale`/`uselocale`
results, worker-thread state, `nl_langinfo` output or GLib's cached effective
charset. An exec-process observation cannot establish PID 1 or its threads'
native state. No native getter is invoked by this collector.

The existing [three-file projection](../scripts/runtime-evidence.mjs) reconstructs
this section only after strict key, source, bound, status and token validation.
Extra fields, path values/hashes, arbitrary recognized values and claimed native
observations degrade the section to fixed unknown evidence. Missing sections in
older reports also become unknown while preserving useful inventory, source
binding and schema compatibility. Charset evidence does not change the smoke
or projection completeness gate. The projection still publishes only
`runtime-summary.json`, `runtime-summary.txt`, and `checksums.txt`; existing
approved report hashes remain report identities, not new hashes of environment
or override values.

Focused helper and projection tests cover private values/errors, separate scopes,
selected-key access, duplicates, truncated and capped reads, malformed section
rejection and older evidence. Their success verifies this collection/projection
contract. Actual-image fixtures, final reviewed-source CI, complete smoke and
deployment-specific acceptance retain their own identities and limits. Both
VARD-54 findings stay visible and open until supported binary remediation and
review establish the required result.
