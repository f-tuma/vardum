# Musubi pilot evaluation

Checkpoint: **2026-10-14**, VARD-16. This report evaluates the existing asset
handoff; it does not implement Templates or authorize another release/deployment.

## Decision and acceptance

The owner explicitly accepts the pilot's value: centralized control over all
assets is the important outcome, and measuring saved minutes is unnecessary.
This is **owner-reported qualitative acceptance**, not a timed productivity
study or evidence of demand from other teams. There is no remaining mandatory
baseline, stopwatch or paired-benchmark task for this evaluation. No percentage
or number of saved minutes is claimed.

The technical results support continuing with centralized asset management:
public web references follow intentional updates, private project files can be
adopted and updated explicitly, and retained historical snapshots remain usable.
Artwork composition and most observed exports were still prepared manually.

| Task | State after this evaluation |
| --- | --- |
| VARD-16 functional pilot and owner-value evaluation | Accepted for the recorded scope. |
| VARD-16 whole task | Still Started because its explicit inward VARD-7 deployment dependency is open. Saved-minute measurements are no longer an outstanding acceptance item. |
| VARD-7 deployment/provider acceptance | Still Started; this report does not establish server identity, database role, SMTP, backup or provider configuration. Existing operator risk acceptance is unchanged. |
| VARD-17 first use | Todo pending a real person unfamiliar with Vardum; the owner/agent-assisted pilot does not substitute. |
| VARD-24 recipe runtime | Still behind its pilot/onboarding sequence; the existing design proposal is not an implemented recipe. Locked recipe outputs additionally require VARD-26 and the preservation contract. |

## Observed results

These are bounded observations, rather than service-level guarantees. The live
folder test used public CLI **0.8.2**, shared **0.4.1**, Node **22.23.3** and
schema **2**. Older isolated conflict/deletion checks used CLI **0.8.0** and
shared **0.4.0**; those results are not relabelled as new-version live tests.

| Scenario | Directly observed result | Scope and limit |
| --- | --- | --- |
| Public web-app OG update, twice | Two approved, visibly different PNG versions were uploaded to the same asset/key/stable URL. Actual declared-image rendering and exact HTTP bytes changed; previous immutable versions remained available. | App/login OG metadata and an image viewer were checked, not an OG image in the app body or social-crawler refresh. Marketing is a separate consumer. |
| Second OG update | New bytes were observed at **+11.656 s** and **+147.967 s** after the Upload click. Ordinary navigation in the same pre-warmed browser session displayed the new subtitle at **+19.295 s**. | Observation times include the chosen check schedule. They are not operator effort, exact processing time, a cache-isolated benchmark or a universal freshness bound. |
| First OG update | New bytes were observed at +47.341, +125.435 and +376.774 s; the pre-warmed browser displayed the new image at +77.490 s. | Different check schedules/cache conditions prevent interpreting the second run as a measured speed improvement. |
| Unrelated public icons/history | Favicon and Apple icon versions/checksums stayed unchanged. The previous OG immutable PNG retained its exact bytes; the UI offered the previous versions for Restore. | This test did not execute an OG restore. Previously downloaded/publicly cached bytes are not revoked. |
| Existing private project files | `status --adopt-existing` planned eight adoptions without writing a lock. `pull --adopt-existing` adopted all eight without rewriting PNG/config bytes and produced the exact original schema-2 lock. | This establishes matching-file adoption behavior, not a timed onboarding saving. |
| New private folder member | Adding a narrow empty rule kept eight outputs; a single library upload without `--output` then generated a ninth output. Status planned one pull; pull downloaded only that output. | Source prefix `pilot/folder-membership-oct14/`, output `_vardum-pilot/og.png`; consumer writes occurred only in an isolated scratch copy. |
| Explicit removal | CAS removal of only the owned rule returned the live manifest from nine outputs to eight. `status --delete` planned one unapplied deletion; `pull --delete` removed only the owned scratch file. | Original eight mappings, literal saved pins, flags, keys, versions, PNGs, configuration and sentinel stayed unchanged. The private test source/version was retained. |
| Historical frozen membership | A genuinely empty consumer restored all nine exact saved outputs while the live manifest contained eight. The saved nine-output lock was unchanged. | Availability depends on retained versions and authorized delivery. The original application was not modified or released by this test. |
| Private delivery | Anonymous stable and immutable requests for the retained private test asset both returned 401. | This is endpoint behavior, not a bucket-policy or runtime-role audit. |
| Local conflict and cleanup components | Separate isolated checks preserved a locally modified file, rejected overwriting it and verified explicit stale deletion. | The older deletion fixture used a synthetic loopback manifest; it is distinct from the real-server folder test above. |

The original and final eight-output locks both have SHA256
`24b7327a7ee26ebebcb8a2ee0244a0f27b044ecae16e2ed0daa4cc592121be06`.
Both human gateway UI edits were kept outside this work.

No Musubi deployment, restart or source change was initiated by either OG test.
The operator reported that the last deployment was from the release tag.
Container IDs/start timestamps or history spanning the test were not available;
an independent interval-wide no-deploy/no-restart assertion is therefore not
established. The existing operator decision is not revoked by that limit.

## What changed compared with the previous arrangement

Historical source is evidence of repository structure, not a complete account of
how long the team worked or which unrecorded tools it used. Before the web-app
migration, `apps/web/src/brand.ts` already referenced a fixed object-storage base
URL. Git already retained committed mobile files. Neither live URLs nor retained
Git files are unique benefits introduced by Vardum.

| Work | Previous source arrangement | Pilot arrangement and useful difference |
| --- | --- | --- |
| Find and control current artwork | Web-app bucket references and committed mobile images were managed through their respective destinations. Actual team search effort was not measured. | Asset identity, current version, history, visibility and project mappings are managed in one workspace. The owner identifies this central control as the principal benefit. |
| Change a public web image | Replacing bytes under an existing bucket key can also preserve a consumer URL, subject to permissions and cache behavior. The pilot did not replay that procedure. | The same Vardum asset reference follows an intentional new version and retains old immutable addresses. The benefit is managed identity/history/control, not an exclusive ability to avoid a consumer deployment. |
| Adopt/update mobile files | Git can preserve already committed files and their history. Manual copying or any former automation was not benchmarked. | Prepared destinations and private delivery connect the shared library to project files. Matching files can enter a snapshot without rewriting them; normal pulls adopt current membership, while frozen pulls use recorded membership and versions. |
| Add/remove a folder output | Historical source does not demonstrate a shared-library inclusion/removal protocol. | A bounded literal prefix rule resolves ready current originals. A local update and its deletion decision remain intentional; there is no background filesystem watcher. |
| Prepare artwork and exports | Existing icons, theme variants and composed cards had prepared files. | The pilot reused manual artwork and exports. No reduction in requirements research, composition or export work is established; an app/web recipe is future work. |
| Operate the workflow | Object storage and repository workflows already had their own operating costs. | Vardum adds setup, browser/API authorization, hosting, retention, backups and compatibility maintenance. Centralization does not remove those responsibilities. |

This comparison is a qualitative product decision backed by functional tests and
the owner's judgment. It is not a claim of quantified savings or validation with
independent customers. More timing research may be useful later, but is optional.

## Priority finding: one source, separate uses (VARD-100)

The owner identified a concrete gap while evaluating the pilot: the same source
artwork should be reusable as separate items in different library folders,
with each use owning its path, dimensions and output format. Re-uploading a
source OG or icon for each context defeats the intended single-source workflow.
The owner requested this before expanding the recipe catalog.

The current Vard API/data model already separates `assetId` from `outputPath`
and `transformation`, allowing one source to back several distinct output paths.
That does not implement reusable library-folder items. A library asset currently
has one workspace key/prefix and its own version history; the new library-use
model has not shipped. Its UI availability and its relation to Vard outputs need
explicit validation rather than assuming that the data model alone completes UX.

VARD-100 will distinguish a source asset/version history from its uses. Each use
needs its own identity/path/settings; changing a source once should update uses
that follow current, while changing one use's settings should leave other uses
and source bytes unchanged. Source privacy, retained immutable versions, existing
URLs, frozen snapshots, push targets and deletion/reference behavior must remain
explicit. Removing a use is not deleting the shared source.

This is a requested capability, not another claim of completed pilot behavior.
No production files are automatically merged or repointed. Marketing and web-app
OG compositions, theme variants and monochrome layers can be genuinely different
artwork; matching names or purposes do not prove a shared source. First identify
an intentionally shared source, then reuse it without copying its original bytes.

## Friction to test with the next person

- **Confirmed cleanup behavior:** an updating pull without `--delete` leaves a
  stale file but drops its snapshot tracking; a later `--delete` will not discover
  it. The cleanup choice belongs on the membership-updating pull. VARD-21 tracks
  comprehension/cleanup-ledger research; this report does not invent a new bug.
- **Live versus frozen comprehension:** web references intentionally follow
  current artwork, while installed mobile releases need their own adoption and
  release. Confusion here is a hypothesis to observe, not a demonstrated new-user
  failure.
- **Library versus project membership:** a library-only `push-folder` does not
  create manual Vard mappings. Membership comes from an existing folder rule or
  an explicit `--output` import. The pilot owner's earlier expectation makes
  this a useful scenario to observe; it does not imply those modes are broken.
- **Recipe needs:** prepared mobile layers, light/dark variants and OG composition
  are concrete inputs for VARD-24. Resizing one logo does not generate all of
  them. Keep the first recipe bounded by the existing design proposal.

The folder test also encountered a local harness assertion expecting JSON action
`download`, whereas the CLI contract reports `pull`. The harness was corrected
and resumed locally without repeating the successful upload. This was not a
product failure or evidence of an extra user retry.

## Next session: VARD-17 first use

Use a real person who has not used Vardum, an approved disposable project/scope,
their own ordinary browser authorization and the current public setup guidance.
The participant should perform the workflow themselves. Do not provide an API
key in a task card, record credentials, silently complete a difficult step, or
count an agent/simulated grant as a new user.

Participant task: **put a supplied non-sensitive image into a new project through
Vardum, commit the resulting project configuration/snapshot and restore it in CI.**
Use the existing interface and guidance. The facilitator privately observes the
following acceptance route; do not require the participant to memorize internal
terms before starting:

1. Create/select the workspace, upload the supplied file and create a Vard.
2. Add its project mapping and destination, copy setup and use real browser login.
3. Pull into the disposable project and inspect the resulting file.
4. Commit configuration, output and snapshot according to the chosen workflow.
5. Run actual frozen CI with an appropriately scoped secret configured through
   the repository's normal authorization flow; verify recorded bytes/membership.

Observation sheet:

| Step/result | What the person understood or tried | Help/errors/retries | Evidence/remaining work |
| --- | --- | --- | --- |
| Workspace and upload | Not run | Not run | Pending real participant |
| Vard, mapping and destination | Not run | Not run | Pending |
| Copied setup and browser login | Not run | Not run | Pending |
| Pull and committed snapshot | Not run | Not run | Pending |
| Actual frozen CI | Not run | Not run | Pending |

VARD-17 already asks to record session time as well as confusion and help. That
is separate usability observation, not a renewed requirement to prove saved
minutes for the accepted Musubi value evaluation. Mark assisted steps honestly;
ask afterward what the person thought a Vard, mapping, live URL and frozen pull
meant. File concrete observed issues, fix them and repeat affected steps.
Optional cleanup comprehension belongs to VARD-21; it does not silently enlarge
this session's existing acceptance. No participant session has happened yet.

## Evidence provenance

The owner statement was supplied directly in this chat on 2026-10-14. Technical
receipts, raw command outputs and screenshots are retained with the pilot owner
and indexed in the private planner (VARD-16, documents 3/27); they are not public
replay fixtures or bundled private artwork. Relevant receipt bundle identifiers:

- `vard16-og-pilot-oct14`: first approved visible update, HTTP checks and browser.
- `vard16-og-second-pilot-oct14`: second approved update, unchanged icons/history,
  public consumer metadata, screenshots and final independent reviews.
- `vard16-folder-pilot-oct14`: revision-guarded editor/manifests, actual CLI
  commands, inventories/locks, retained private source, denial probes and reviews.
- `musubi-local-conflict-oct12` and `musubi-stale-delete-oct12`: older isolated
  component checks, explicitly separate from real-server acceptance.

Source/publication anchors:

- [Musubi mobile integration PR340](https://github.com/f-tuma/musubi/pull/340),
  [web-app integration PR341](https://github.com/f-tuma/musubi/pull/341) and
  [separate marketing integration PR1](https://github.com/f-tuma/musubi-web/pull/1).
- The pre-web-app-migration bucket reference is in the parent of Musubi commit
  `b873022ab572ef0199f668d978c48ac3984e0ed2`, `apps/web/src/brand.ts`.
- [Musubi v0.2.3 publication](https://github.com/f-tuma/musubi/releases/tag/v0.2.3)
  belongs to the other release workflow/chat; this evaluation does not take it over.
- [CLI 0.8.2 public publication evidence](client-release-0.8.2.md#publication-evidence)
  and [the app/web recipe proposal](template-recipe-model.md) remain separate from
  actual human onboarding and future recipe implementation.

Each executed OG/folder slice already passed independent review and skeptical
review. Report synthesis does not add a new runtime measurement or replace
the separate deployment and human-use acceptance.
