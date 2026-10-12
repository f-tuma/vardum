# Vardum product roadmap

Decision recorded 2026-10-11. This is the agreed order of work, not a statement
that the listed capabilities have shipped. Itsaplan project `frgtn.VARD` holds
live issue states and acceptance evidence. Its product-plan document is 27;
status sync is document 3. The original Cloudinary research is preserved as
reference document 26, with its proposals and assumptions distinguished from
accepted implementation contracts.

## Product outcome

A shared library preserves source artwork, version history and knowledge of how
assets should be used. Connected projects receive suitable outputs on their own
release schedule. The second brand update should reduce requirements research,
manual exports and copying while preserving independent releases.

A transformation **preset** names an image specification. A **Template** also
specifies input slots, multiple outputs, preview contexts, checks and guidance.
Useful Templates are the next product milestone after dependable project
handoff; they do not require a complete media-processing platform.

Each consumer chooses its update behavior:

- **Live delivery:** public current-version URLs intentionally follow the latest
  artwork. Browser, intermediary and social caches can delay visible changes.
- **Locked delivery:** an intentional update resolves project inputs; release
  builds consume recorded membership, versions, paths, transformations and
  verified bytes with `pull --frozen`.
- **PR updates:** an explicitly connected locked consumer may opt into proposed
  updates for review. This is planned automation, not current upload behavior.

Uploading a version does not authorize changes to every connected repository.
Projects using live URLs do not need an update PR for each artwork change.

## Active order

### 1. Complete the dependable handoff

Finish the remaining Musubi pilot evidence (VARD-16), production card rollout
(VARD-78), public npm onboarding (VARD-77) and real human first-use validation
(VARD-17). Implementation, merge, publication and deployment are separate facts.

At this checkpoint, mobile frozen delivery and marketing live delivery have
passed their recorded acceptance. The Musubi web-app source PR has merged;
its release, deployment and live consumer verification remain separate work.
The pilot still needs an agreed visibly different artwork and a measured second
update. A metadata-only version does not demonstrate a visible brand change.

While external deployment or human input is pending, VARD-77 is the first
independently actionable implementation: self-contained public package guidance,
correct Setup naming and a verified new patch release. A source README merge
does not change an already published npm archive. Existing versions, release
archives and tags must remain unchanged; promote setup pins only after verifying
the new publication.

Runtime, provider and server-release acceptance remain independent tasks
(VARD-6, VARD-7 through VARD-13 and their security follow-ups). This roadmap
does not close those gates or broaden an operator's existing risk acceptance.

### 2. Deliver one useful recipe with a preservation contract

See the [app/web recipe design proposal](template-recipe-model.md) for observed
Musubi inputs and the staged model. This design does not satisfy the pilot gate
or implement Templates.

1. **VARD-82:** define original and derivative retention, renderer identity and
   byte-reproduction guarantees. An ADR and failure proof can proceed while
   the pilot waits for external input. Do not introduce automatic derived-cache
   deletion before that contract is accepted.
2. **VARD-24:** after its pilot dependency, define a bounded app/web Template
   model and one recipe using real Musubi inputs, existing transformations and
   manually composed artwork.
3. **VARD-26:** after VARD-24 and VARD-82, add immutable preset/template revisions
   and expanded resolved recipe inputs and outputs to a compatible snapshot
   contract. Wire or schema changes require their own compatibility and release
   acceptance. Production locked recipe outputs wait for this contract.
4. **VARD-25:** after VARD-24 and VARD-26, add context previews, masks, safe-area
   guidance and checks for that recipe. Clearly distinguish requirements,
   recommendations and human review. A preview cannot guarantee store approval.

The interface should ask which output the user needs and show the result.
Additional crop, focal-point, padding or rotation options should address a
specific recipe need, rather than requiring a broad transformation catalog.
Team recipe sharing (VARD-27) follows actual use of the basic recipes.

### 3. Show change impact and add opt-in automation

- **VARD-28:** record explicitly known consumers, destinations and update modes.
  Delivery analytics are not a complete inventory of asset use.
  See [known usage](known-usage.md) for explicit registration, current-source
  resolution and manual checks. Inventory does not require the future recipe
  model and can proceed independently while external pilot evidence is pending.
- **VARD-85:** after VARD-28, show before/after output differences, membership and
  parameter changes. Keep private previews authorized and report unavailable
  history, local conflicts and deletion choices.
- **VARD-86:** after repeated demand and change-review acceptance, validate one
  repository's GitHub Action that proposes locked updates. Batch related changes
  into a reviewable PR. A GitHub App can follow adoption; consumer PRs are not
  automatically merged by the service.
- **VARD-84:** signed webhooks can later provide a trigger. They are not required
  for the first manual or scheduled Action. Durable delivery and endpoint
  security must be designed before production webhook use.

Configured usage monitoring (VARD-29/30), sharing (VARD-27) and validation with
other teams (VARD-23) remain distinct follow-ups.

## Conditional backlog

These are future opportunities, not automatic pilot or release blockers. Select
a real consumer, confirm the need and define the smallest testable slice before
activation. Acceptance details are on the corresponding planner issues.

| Issue | Opportunity | First boundary |
| --- | --- | --- |
| VARD-80 | Focal point and practical image operations | Manual focal crop first; pad, rotate, trim and effects as required by a recipe. Revisioned overlays later. |
| VARD-81 | Responsive outputs and format selection | Explicit sizes/formats and picture helpers; negotiation and measured quality optimization later. |
| VARD-82 | Derivative preservation | Retention and renderer contract before GC or newly locked recipes. |
| VARD-83 | Eager derivation and job status | Bounded, idempotent jobs; isolate transformer work when measurements justify it. |
| VARD-84 | Signed webhooks | Durable delivery ledger, retries, replay verification and endpoint validation. |
| VARD-85 | Visual change review | Actual old locked state versus proposed resolved state; private previews. |
| VARD-86 | Proposed repository updates | Explicit opt-in and one-repository Action before a GitHub App. |
| VARD-87 | Useful metadata | Tags, licensing and overridable localized default alt; typed fields, EXIF and placeholders later. |
| VARD-88 | Metadata search | Needed filters first, preserving existing cursor and tenant contracts. |
| VARD-89 | Upload rules by prefix | Predictable limits and required fields without overwriting originals or silently publishing files. |
| VARD-90 | Expiring private sharing | Scoped, revocable grants and a private cache contract. |
| VARD-91 | CDN delivery | Measure benefit and test public/private cache isolation on the chosen provider. |
| VARD-92 | Video processing | Confirm demand, then probe/poster; trim/MP4 and HLS are later slices. |
| VARD-93 | Optional AI jobs | Explicit processing with visible costs; new versions or human-approved metadata proposals. |
| VARD-94 | Remote MCP | Scoped authorization and guarded existing API contracts; local MCP remains supported. |
| VARD-95 | Web SDKs and signing | A small builder and a real framework consumer before multiple adapters; server-only, rotatable scoped signing. |

Reuse existing work instead of opening duplicate feature tracks:

- VARD-24 through VARD-28: Templates, previews, locking, sharing and known usage.
- VARD-31: hosted offering, billing and self-host priorities.
- VARD-32: the first needed additional digital-file formats, including potential
  PDF/raw delivery; do not promise previews for every format.
- VARD-34: large-file S3 multipart if needed. Delivered CLI upload journals and
  folder retries are separate capabilities, not unfinished work on this issue.
- VARD-36: analytics batching based on measured database load and coverage.
- VARD-37: same-derivative deduplication across replicas based on measured overlap.
- VARD-76: explicit adoption of existing checksum-matching project files.

Face detection, HLS, broad effects, perceptual quality search and generative AI
remain demand-driven experiments. A general design editor, marketplace and
low-code workflow canvas remain outside the current product milestone.

## Contracts the research must preserve

- Retaining an original and canonical specification does not guarantee identical
  regenerated bytes after sharp/libvips/encoder upgrades. The server does not
  know every historical lockfile committed in another repository. A rule such as
  deleting derivatives after 90 days is not safe merely because a current Vard
  no longer references them. Preserve existing v1 cache/signature semantics and
  fail closed on frozen checksum mismatches.
- A focal point, preset or metadata value affecting output must resolve to
  immutable values or revisions. Updating it must not replace bytes behind an
  existing immutable output URL.
- Current transform advisory locks provide global capacity admission. The
  same-variant generation map is process-local; it is not distributed per-key
  deduplication. VARD-37 addresses that distinction.
- Public presets must not grant access to private assets or allow unlimited
  unsigned variants. Share links and workspace SDK signing are new security
  contracts, not silent replacements of existing signing behavior.
- The VARD-14 identity/schema draft keeps its own integration dependencies and
  release acceptance. A roadmap update does not certify it or bypass those gates.
- Automatic format or quality selection must resolve before locking. A default
  quality value is a heuristic, not a demonstrated perceptual optimizer.
- Default alt metadata needs a per-use override; decorative images can require
  empty alt. Source metadata alone cannot decide every image's accessibility.
- An audit timestamp cursor is not sufficient evidence of reliable webhook
  delivery: transactions can commit out of timestamp order. Use a durable
  delivery mechanism that cannot silently skip such events.
- A short current-URL redirect cache is not a promise of immediate changes in
  open pages, favicons or social previews. Versions and MCP alone are not unique
  differentiation; the product focuses on dependable project handoff.

## Incremental delivery loop

1. Read the live issue, dependencies and acceptance. Choose one ready slice and
   mark it started. Continue independent work while external evidence is pending.
2. Obtain a fresh-context plan for major implementation. Follow relevant
   repository and skill instructions; isolate work from unrelated user changes.
3. Implement the smallest reviewable slice and meaningful checks appropriate to
   its impact, including compatibility, privacy, resource and failure behavior.
   Validate rendered UI in a browser when the slice changes it.
4. Obtain independent fresh-context review and skepticism of the final diff and
   evidence after each completed slice. Address blockers and review changes.
5. Open or update the PR after review, verify all required checks on that exact
   reviewed head, then squash merge without bypassing repository protections.
6. Verify the resulting merge, update planner evidence and clean up the owned
   checkout after preserving needed files. Mark Done only for the issue's actual
   scope; source merge does not substitute for publication, deployment or human
   acceptance.
7. Release new versions through the verified GitHub Actions process. Preserve
   existing published artifacts and test the exact candidate archives. Missing
   production access, a required operating step or a human decision remains
   explicit pending work; it is not implicit approval.

The active goal follows this bounded plan. Conditional ideas require their own
activation evidence and do not create an endless implementation scope.
