# Proposal: review an intentional asset update

Status: design preparation, 2026-10-12, VARD-85. This document ships no review
endpoint, snapshot importer, preview UI or update command. VARD-85 remains
incomplete; runtime work follows the Musubi pilot (VARD-16) and basic recipe
implementation (VARD-24). Production locked recipe review also requires VARD-26.
The merged VARD-24 design is not a runtime recipe. [ADR 0001](adr/0001-derived-output-preservation.md)
records preservation decisions and failure proof, not a retention service or GC.
VARD-28 supplies known consumer evidence; its completion alone does not clear
the pilot and recipe gates. Live cards remain the acceptance records.

## Observed need and first boundary

Musubi's mobile project consumes eight manually prepared original PNGs through
a committed schema 2 snapshot. The observed files match their locked SHA-256
values and use original delivery. An intentional update should show what would
change while an older mobile commit continues to describe its own file set.
An installed application adopts artwork through its own release process.

Use this existing manual frozen workflow to define the first comparison. The
marketing site's intentional live references have no equivalent frozen baseline;
do not present them as an old locked web state. App deployment, approved visible
artwork, second-update measurements and remaining pilot acceptance stay separate.
Examples below are synthetic labels, not accepted wire values or private data.
No private asset IDs, artwork, lock URLs or transformation signatures belong here.

## Four distinct inputs

| Input | Meaning | What it cannot establish |
| --- | --- | --- |
| Old snapshot | The consumer's actual selected committed schema 2 lock, with its provenance reference | Current deployment, current remote availability or permission |
| Proposed state | One captured, fully resolved manifest from the authorized target workspace/Vard | Verified transformed output bytes or a future locked recipe revision |
| Local observation | Current project file existence and checksum, recorded separately | The committed baseline or adoption of a remote change |
| Known usage | VARD-28 declarations and dated human reports for known destinations | A complete inventory, independently obtained lock or verified deployed output |

The caller selects the old commit or snapshot explicitly. Do not manufacture it
from current library versions, the saved editor configuration or a manual report.
A source report labelled Manual frozen remains a report, not a snapshot import.
Record when and from where the proposal and local observations were captured.
The first plan consumes supplied captures and bytes; it performs no network calls.

## Preserve the existing contracts

Schema 2 records server, workspace, Vard and output-ID-keyed entries containing
path, source version, fingerprint, download URL and downloaded-output checksum.
Validate the selected snapshot against the intended configuration using the
existing [client rules](../apps/cli/src/sync.ts). Schema 1 is insufficient for this
comparison; reject an incomplete or wrongly bound snapshot without refreshing it.
Bind the proposed capture to that same server, workspace and Vard; reject duplicate
output IDs. A supplied context label is neither provenance nor authorization.
Validate immutable version URLs, safe relative paths, case/Unicode collisions,
overlapping paths and the complete old and proposed output namespaces.

The lock does not record assetId, descriptive metadata, decoded dimensions,
Template/preset revision or renderer identity. Its checksum identifies output
bytes. The manifest's sourceChecksum identifies the source original; for a
transformed output it cannot substitute for a downloaded-output checksum.
The current fingerprint combines source version and canonical transformation.
Equal fingerprints do not prove equal encoded bytes after an encoder/cache change.

The [resolved payload](../apps/api/src/vard-payload.ts) expands manual mappings and
folder rules before namespace validation. Compare that complete captured set;
projecting one known binding must not hide a collision or resource-limit failure.
This proposal adds no fields to schema 2, activates no schema 3 draft, and selects
no new recipe API, signing scheme or historical rendering architecture.

## Describe only differences supported by evidence

Match stable output IDs where available, retaining both paths. Generated folder
IDs include destination identity, so a path change can appear as removal/addition.
Do not infer a move or source-asset relationship from similar filenames or pixels.
A reused manual mapping ID proves mapping continuity, not unchanged asset binding:
schema 2 has no old assetId. Keep the observable difference and the unknown fact.

| Observation | Proposed classification | Required qualification |
| --- | --- | --- |
| ID only in new set | Added output | Existing local file at its path may conflict |
| ID only in old set | Removed output | Removal from membership does not authorize local deletion |
| Same ID, different path | Mapping path changed | Validate both namespaces and inspect the destination separately |
| Same ID/path, different source version | Source version changed | Old source asset identity may be unknown |
| Same ID/path, comparable canonical parameters differ | Output parameters changed | Show evidenced old/new values; unavailable values stay unknown |
| Different IDs at the same path | Output identity replaced at path | Do not claim an asset replacement without old asset evidence |
| Same ID/path/version/fingerprint | No recorded specification change | Visual/byte equality and renderer identity are separate facts |
| Missing version or unresolved proposed output | Proposed output unavailable | Never substitute another ready source |
| Unavailable or mismatching old bytes | Old visual unavailable | Keep the old row, checksum and reason visible |
| No historical metadata value | Old metadata unknown | Current metadata cannot serve as the historical value |

Canonical parameters may be compared only when both captures expose a validated,
unambiguous supported spec. An opaque fingerprint is not an arbitrary metadata
decoder. New declared dimensions, format or MIME stay separate from properties
decoded from supplied bytes. Schema 2 contains no old alt text, licence or name
history. Report an unsupported comparison rather than inventing that history.

For example, synthetic output A at `images/icon.png` may keep its mapping while
its version changes; output B may disappear; output C may be added at B's old path.
Show B removed and C added, with a same-path replacement relationship. Do not
delete C's proposed destination because B previously occupied it. Similar artwork
or paths alone do not establish that B and C belong to the same source asset.

## Verify bytes before showing an old visual

The first design uses supplied local bytes for the old visual. Hash each candidate
against the selected lock's output SHA-256 before decoding or displaying it. A
modified working file is local evidence, not an old visual. A separate retained
local copy may supply the verified old visual while that working file conflicts.

| Byte evidence | Display/result |
| --- | --- |
| Supplied old bytes match lock digest | Verified local old output; remote availability remains unverified |
| No supplied old bytes | Old visual unavailable in this plan; no automatic download |
| Supplied old bytes mismatch | Integrity failure; no old visual and no fallback |
| Separately captured remote not-found/storage loss | Remote output unavailable; matching local evidence remains separately labelled |
| Separately captured denied/revoked access | Access unavailable; local possession does not grant server read permission |
| Historical delivery returns regenerated different bytes | Digest mismatch; never display them as the locked old output |
| Supplied proposal bytes have verified output provenance and matching digest | Captured proposal visual, distinct from an adopted snapshot |
| Proposed transformed bytes lack verifiable output evidence | Proposed visual unavailable; sourceChecksum is insufficient |

An original proposed output can be checked against its captured source checksum
when the proposal confirms original delivery and exact source version. Transformed
proposal bytes need independently established output identity/configuration and
expected digest; merely hashing arbitrary supplied bytes proves no provenance.
Selecting that evidence mechanism is an open runtime decision. Without it, defer
the new visual while retaining the declared proposed state and available old view.
Never fetch latest as a replacement, silently relock, or bypass a checksum.

## A plan that performs no writes

Build this first plan from supplied inputs without calling normal pull, stock
delivery GETs or a thumbnail URL. Existing delivery GETs record analytics, and
a transformed cache miss can store regenerated derivatives. Treating these as
exempt would weaken the no-write acceptance. Remote preview retrieval is deferred
until an explicitly accepted read-only contract exists; this design adds none.

Planning and cancellation must leave project files, lock, config, assets, Vards,
reports and server storage unchanged. Keep verification results in memory; discard
them on cancellation. An unavailable visual is a useful result, not permission
to upload, regenerate, mutate current pointers or apply the proposed change.
Adoption remains a separate intentional operation subject to existing conflict,
deletion, digest and release rules; this document provides no apply mechanism.

## Show local conflicts and removal choices

| Proposed row | Separate local observation | Review result and future adoption boundary |
| --- | --- | --- |
| Added/changed output | Destination absent | Candidate write; this plan writes nothing |
| Changed output | Working file matches old lock checksum | Local baseline intact; proposal bytes may still be unavailable |
| Any destination write | File differs from old digest or has no matching tracked baseline | Local conflict; retain the file and show it explicitly |
| Removed output | File matches old tracked digest | Stale tracked file; keep unless deletion is explicitly selected |
| Removed output | File differs from old tracked digest | Deletion conflict; show modification and protect it |
| Removed output | File absent | No local deletion required; membership removal remains visible |
| Different IDs occupy one path across captures | File exists | Same-path replacement; assess write conflict and never delete the new output as stale |
| Unknown local state | Observation absent/unreadable/unsafe | Conflict status unknown; no claim of a safe write/deletion |

List every removal even when deletion is not selected. A path change shows both
the candidate destination and the prior path's retention/deletion choice.
Do not inherit today's status omission of unselected stale rows or hide other
rows when one stale file is modified. Declining the proposal changes nothing.
Unknown and unavailable conditions remain visible alongside actionable rows.

## Authorization, limits and a stable proposal

Keep the review private to its authorized workspace. A public manifest, valid
transformation signature, known consumer or locally held copy grants no private
server access. Any later server retrieval must check current read authorization
before cache access, remain same-origin, reject credential-bearing URLs and
redirects, and retain private non-storeable response behavior. No secret URL or
private bytes may enter public reports, share links, telemetry or documentation.
Local custody and remote access are distinct; selecting authorization checks for
locally supplied private previews remains part of runtime security design.

Set explicit lock/capture size, output-count, byte, decoded-pixel, concurrency and
timeout limits before implementation. Reuse compatible path/namespace rules;
do not infer a total historical-snapshot limit from the current live-manifest cap.
The first visual scope is bounded still PNG decoding. Treat supplied images as
untrusted and select a safe decoding/isolation approach; exclude arbitrary SVG
execution, animation and video until separately specified. Release temporary
memory/object URLs after cancellation and keep private previews out of persistence.

Display capture provenance and age. A review concerns one captured proposal;
later source uploads or folder changes do not silently alter it. The existing
editor OCC revision deliberately excludes live source versions and generated
membership. It cannot alone prove the proposal remains current. Any future
adoption must revalidate the resolved set and local observations, then request
fresh review on drift. No cross-file transaction or automatic adoption is implied.

## Decisions and prospective verification

Runtime work must select input/provenance transport, resource limits, safe PNG
decoding, authorization freshness, proposal-byte evidence and drift detection.
It must define accessible text equivalents for both views, keyboard/focus behavior,
loading/error announcements and narrow layouts. A visual overlay must never be
the only way to identify changes, uncertainty, conflicts or removal choices.
These decisions do not expand this proposal into wire changes or GitHub automation.

| Future verification | Required evidence |
| --- | --- |
| Snapshot binding, malformed input and full namespaces | Reject wrong/schema1/unsafe/colliding/over-limit input without mutation |
| Added/removed/moved/same-path outputs and unknown asset identity | Complete rows; only evidence-supported identity claims |
| Old PNG, missing bytes and encoder/cache drift | Digest verified before display; mismatch never substitutes latest |
| Proposed originals/transforms and unknown metadata | Distinguish source/output checksums and unsupported comparisons |
| Local edits, stale paths and cancellation | Conflicts/removal choices visible; files/lock/server storage unchanged |
| Private/tenant/URL boundaries and decoder limits | Denial preserved; no leaked bytes, redirects, writes or unbounded work |
| Source/folder drift after editor revision is captured | Changed resolved proposal requires fresh review |
| Known inventory, accessibility and old-client compatibility | No completeness/adoption claim; usable review; schema 2 unchanged |

This matrix specifies future tests; it is not a record of a shipped implementation
or passed runtime acceptance. See [the ordered roadmap](product-roadmap.md),
[the recipe proposal](template-recipe-model.md), [known usage](known-usage.md) and
[ADR 0001](adr/0001-derived-output-preservation.md) for the surrounding gates.
