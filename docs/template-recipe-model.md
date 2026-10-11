# Proposal: the first app/web Template recipe

Status: design proposal, 2026-10-11, VARD-24. No Template API, stored preset,
recipe interpreter or new snapshot format is shipped by this document.

This prepares the design part of VARD-24 while the Musubi pilot (VARD-16) awaits
its remaining production and visible-update acceptance. Runtime implementation
still follows that dependency. Production locked recipe outputs also require
VARD-26 and the preservation contract in [ADR 0001](adr/0001-derived-output-preservation.md).
VARD-25 owns the subsequent preview/check UI. A documentation merge does not
complete those tasks, approve artwork or publish a consuming application.

## Problem and first useful result

Musubi already consumes eight frozen mobile images, three live marketing assets
and five live web-app assets in merged source. Their roles differ: an opaque app
icon, a transparent splash image, a pair of theme-coloured logo masks and a
composed social card cannot be substituted for each other by resizing a logo.

The first recipe should preserve this knowledge: which prepared input serves
which role, its expected canvas/content, its destination and its update mode.
Selecting the recipe must not invent artwork or publish private inputs. The
existing manual Vard mappings remain useful before the Template feature exists.

The initial recipe is **App and web brand assets**, with independently selected
mobile, marketing and web-app profiles. Musubi is its observed reference case,
not a bundle of artwork licensed for reuse by other teams. Recipe declarations
contain requirements and guidance; a team's asset bindings remain in its own
workspace. No private artwork, asset IDs or signed URLs belong in the recipe.

## Existing capabilities and their limits

The current [wire model](../packages/shared/src/wire.ts) describes Vard mappings,
folder rules and `w`, `h`, `fit`, `format`, `q` transformations. The current API
has no persistent named-preset or Template model. A named transformation preset
and a multi-output Template remain separate proposed concepts.

An output can use its original prepared file or the current
[resize/encode operations](../apps/api/src/transformation.ts). The first observed
Musubi recipe needs originals; adding an artificial transform would re-encode
approved artwork without solving a consumer need. Original SVG delivery and
raster transformation are different: resizing an SVG rasterizes it, and cannot
preserve the SVG logo-mask contract.

The existing operations do not compose OG text, add a designed opaque plate,
extract two logo arms, prepare a monochrome silhouette or establish a platform
safe area. `inside` may produce a smaller canvas; `cover` can crop and `fill` can
distort. A PNG alpha channel does not establish that every pixel is opaque, nor
that the artwork has the right visual composition. Do not claim these operations
meet a role's requirements without checking the actual result.

## Proposed declarations

These are domain concepts for design review, not TypeScript exports, accepted
request fields or a new `vardum.json`/`.vardum.lock` schema.

| Concept | Minimum information |
| --- | --- |
| Template | Stable identity, revision, title, selected target profiles, slot and output declarations, scope of guidance. Revision persistence/immutability is implemented by VARD-26. |
| Input slot | Stable role ID; required or optional within a profile; allowed MIME types; expected canvas and alpha/content constraints; whether separately composed artwork is required; human review guidance. |
| Output | Stable output ID and purpose; exactly one input slot; original delivery or a complete supported transformation; expected output MIME/canvas/content; destination filename/path or configured public library key. |
| Consumer binding | Selected profiles; workspace-owned slot-to-asset bindings; project output root or public destinations; explicit `manualFrozen` or `publicLive` choice. These labels are proposed concepts, not existing wire fields. |

A selected profile requires all of the inputs listed for it below, because its
current consumer uses all of them. A user may leave a profile unselected. That
does not silently remove files from a previously locked project.

The general model may support optional slots: omitting one omits only outputs
declared to depend on it. An optional slot must never satisfy a required output
through an inferred fallback. This first recipe has no invented optional artwork;
optional roles can be added when an actual consumer needs them.

Output roots and public library prefixes are consumer configuration, not baked-in
`vardum/` folders. File destinations are safe repository-relative paths, with one
suffix for the actual output format. A library asset name and a project filename
remain distinct. Validate path traversal, absolute paths and collisions using
the delivery client's compatible rules before proposing writes. Profile expansion
must not bypass existing total-output/resource limits.

## The observed Musubi recipe

The values below describe source and decoded files observed on 2026-10-11. They
are reference constraints for this recipe, **not current Apple, Android, Expo or
social-platform submission rules**. No store approval is implied. A future
platform-specific recipe must record primary vendor sources and when they were
verified, rather than copy these values as universal requirements.

### Mobile: eight manually prepared originals

The consumer's Vardum root is `apps/client/assets`; the destination paths below
are relative to it. All eight committed files match the existing schema 2
snapshot checksums and use original delivery, with no transform query. Their
visibility remains private and their update mode is manual frozen adoption.

| Required slot | Destination | Observed prepared input | Consumer role |
| --- | --- | --- | --- |
| `icon-dark` | `images/icon.png` | PNG, 1024 × 1024, opaque pixels | Base app icon and iOS dark icon |
| `icon-light` | `images/icon-light.png` | PNG, 1024 × 1024, opaque pixels | iOS light icon |
| `android-foreground` | `images/android-icon-foreground.png` | PNG, 1024 × 1024, contains transparency | Adaptive foreground |
| `android-background` | `images/android-icon-background.png` | PNG, 1024 × 1024, opaque pixels | Adaptive background |
| `android-monochrome` | `images/android-icon-monochrome.png` | PNG, 1024 × 1024, contains transparency | Prepared monochrome layer; its visual correctness requires review |
| `splash-dark` | `images/splash-icon.png` | PNG, 1024 × 1024, contains transparency | Dark splash artwork |
| `splash-light` | `images/splash-icon-light.png` | PNG, 1024 × 1024, contains transparency | Light splash artwork |
| `expo-favicon` | `images/favicon.png` | PNG, 48 × 48, contains transparency | Expo web favicon |

The consumer supplies its splash background colours, display width/resize mode
and adaptive-icon background colour. These are application settings, not hidden
transform defaults. A future recipe may describe them as handoff guidance; it
must not pretend it edits app configuration. The observed light splash is square;
an older Musubi specification's 1024 × 512 description is not its current export.

### Marketing: three distinct public live originals

| Required slot | Observed public key | Observed prepared input |
| --- | --- | --- |
| `website-logo` | `brand/website/logo` | SVG, viewBox `0 0 48 48`, separate logo artwork |
| `website-favicon` | `brand/website/favicon` | SVG, viewBox `0 0 48 48`, separate favicon artwork |
| `website-social` | `brand/website/og` | PNG, 1200 × 630, opaque composed card |

The actual consumer is `musubi-web`, whose brand references intentionally follow
current artwork. The PNG card is not generated from the SVG by this proposal.
These public inputs and destinations are separate from the mobile private files.
Live artwork can change without redeploying a consumer that already uses those
references; browser/CDN/social caches can delay what a user sees.

### Web application: five distinct public live originals

| Required slot | Observed public key | Observed prepared input |
| --- | --- | --- |
| `app-favicon` | `brand/web-app/favicon` | SVG, viewBox `0 0 48 48` |
| `app-touch-icon` | `brand/web-app/apple-touch-icon` | PNG, 180 × 180, opaque pixels; also used as the notification icon |
| `app-social` | `brand/web-app/og` | PNG, 1200 × 630, opaque composed card |
| `app-ink-arm` | `brand/web-app/logo-ink` | Transparent SVG, viewBox `0 0 48 48`, first alpha-mask arm |
| `app-accent-arm` | `brand/web-app/logo-accent` | Transparent SVG, matching 48 × 48 canvas, second alpha-mask arm |

The app's stable references are merged source; Docker publication, production
deployment and live acceptance remain separate pilot work. The newly prepared
OG draft is not a published current version and still awaits its specific upload
approval. It is not the marketing site's `brand/website/og`.

The app colours the two masks through its local theme. Both must be compatible;
updating two independent live pointers is not atomic. SSR, loading and errors
use the app's bundled complete fallback paths. A Template cannot replace those
fallback paths inside an already released application. Validate paired artwork
and both colour themes manually before intentionally changing the live masks.

## Proposed resolution and checks

After the implementation gates are met, the minimum resolution flow is:

1. Select profiles and a consumer mode; explicitly bind the required slots to
   ready assets in the same authorized workspace.
2. Validate inputs and declare each output's expected format/canvas/content.
   Report a missing slot, unsupported operation, invalid MIME/canvas, unsafe path
   or collision against all manual and folder-generated outputs.
3. For a `publicLive` binding, reject private inputs rather than making them
   public. Existing asset authorization still controls every request; signing a
   transformation or sharing a recipe cannot grant private read access.
4. Show a complete output plan before adoption, including additions, replacements
   and removals. Preserve existing local conflict and explicit-deletion behavior;
   selecting a Template does not authorize overwriting local edits.
5. Adopt through the consumer's chosen mode. An unavailable source or retained
   output is an error, never a reason to substitute latest artwork or re-lock.

Machine checks can validate MIME, decoded dimensions/alpha, required bindings,
paths and supported operations. Human review still owns composition, legibility,
mask alignment, themes and whether the artwork suits its use. Existing inspector
previews are not the planned VARD-25 contexts or a platform certification.

No inferred all-outputs transaction is promised. The current frozen client can
restore earlier verified files before a later file fails. Live changes are
mutable and external caches exist. Neither delivery analytics nor this recipe
discovers every consumer; known usage is separate VARD-28 work.

## Locking and staged delivery

Current schema 2 locks concrete membership, file paths, source versions,
transformation fingerprints, download URLs and downloaded-byte checksums. It has
no resolved Template revision or renderer identity. Preserve that existing
contract and its fail-closed digest checks; do not activate the separate VARD-14
schema draft through this proposal.

VARD-24 can implement a bounded declarative model and recipe after the pilot gate.
VARD-26 then selects and tests compatible immutable Template/preset revisions,
expanded input/output specifications, explicit defaults, source identity and
renderer provenance. Before production locked recipe delivery, enforce the ADR's
retained-byte/digest and publication contract. Keeping an original alone does not
prove the same bytes can be regenerated. A new recipe or renderer must not replace
an already committed output. No automatic derivative GC follows from this design.

VARD-25 adds the actual contextual previews, actionable checks and review UX for
that recipe. VARD-28 later records explicitly known consumers and their chosen
update modes. Opt-in update PRs, crawlers, sharing, store publishers, AI and a
general composition editor are outside this first model.

Design review acceptance for this document is a complete observed slot/output
map, explicit original/manual-artwork boundaries, required/optional semantics,
separate live/frozen destinations and unchanged dependency gates. Runtime
acceptance later needs resolver/privacy/path/resource tests and a real recipe
update with an old frozen rebuild. Those tests and the pilot's visible update,
operator evidence and human onboarding cannot be replaced by documentation.

## Evidence sources

- Musubi source checkpoint `99e613f4d43336131b844b62c3d0c06635ff5964`:
  [mobile configuration](https://github.com/f-tuma/musubi/blob/99e613f4d43336131b844b62c3d0c06635ff5964/apps/client/app.config.ts),
  [committed schema 2 snapshot](https://github.com/f-tuma/musubi/blob/99e613f4d43336131b844b62c3d0c06635ff5964/apps/client/assets/.vardum.lock),
  [web brand references](https://github.com/f-tuma/musubi/blob/99e613f4d43336131b844b62c3d0c06635ff5964/apps/web/src/brand.ts),
  [mask/fallback implementation](https://github.com/f-tuma/musubi/blob/99e613f4d43336131b844b62c3d0c06635ff5964/apps/web/src/components/BrandMark.tsx).
- Marketing source checkpoint `397016f53571eeb099ffa59bbc51a146b8228336`:
  [brand references](https://github.com/f-tuma/musubi-web/blob/397016f53571eeb099ffa59bbc51a146b8228336/src/brand.ts).
- Decoded committed mobile PNGs and the prepared/adopted web artwork were checked
  for dimensions and actual transparency. These are observations, not provider,
  deployment, storage-retention or platform-approval evidence.
- [Product direction](product-direction.md), [ordered roadmap](product-roadmap.md)
  and [ADR 0001](adr/0001-derived-output-preservation.md) define the surrounding
  boundaries. Itsaplan VARD-16, VARD-24, VARD-25, VARD-26 and VARD-28 remain the
  live acceptance records.
