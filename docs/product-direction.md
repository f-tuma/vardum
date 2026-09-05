# Varda: product direction

Status: agreed direction, not a statement of shipped capabilities.

> Manage assets once. Deliver the right variants to connected projects, on each
> project's release schedule.

Varda is an open-source, developer-first asset manager for small teams and
agencies. It connects a shared visual library to real project files, repeatable
exports, and reproducible builds. Over time, it will also help teams check where
outdated assets are still in use.

The software is released under the [MIT License](../LICENSE). All public-facing
content is in English: UI, documentation, CLI messages, and shipped templates.
Uploaded assets retain their own ownership and licensing; hosting them in Varda
does not make them public or MIT-licensed.

Existing `Vardum`, `vardum`, and `@vardum/*` identifiers are unchanged by this
brief. Any naming migration is a separate decision.

## Who and why

The primary users are small teams and agencies maintaining a brand across
multiple applications, websites, repositories, and promotional destinations.
Designers prepare the source material; developers need dependable project inputs.
One person may perform both roles.

The motivating case is a Musubi logo update across a marketing website, a web
application, an Expo project, GitHub README content, and promotional pages.
The work involved finding duplicated or inline assets, discovering platform
requirements, preparing exports, adjusting composition, and checking the result.

The opportunity is not another file store or folder-sync command. It is preserving
knowledge about how assets should be used, then repeating that handoff without
manual copying or unexpected release changes. A single repository with a few
rarely changed images may not need Varda.

## Product model

- **Asset:** a source file with version history. Symbol, wordmark, and light/dark
  artwork can be separate assets.
- **Vard:** a project-specific set of assets and outputs: selected files, folder
  inclusion rules, destination paths, transformations, and version choices.
- **Template:** a reusable recipe describing input slots, output requirements,
  previews, checks, and guidance. It shares a recipe, not the user's artwork.
- **Usage:** a known project or destination that consumes assets, optionally with
  a URL to inspect. It is not proof that every use has been discovered.

Vards must support both explicit file mappings and automatic folder inclusion.
New folder contents become candidates for the next intentional project update;
they must not silently change an already locked build.

## First milestone: a dependable app-and-web handoff

Use Musubi's application and marketing website as the first real acceptance case.
This milestone is about completing a reliable workflow, not adding every feature
below at once.

Required behavior:

- Maintain a shared library with version history and intentional public/private
  access. A private manifest alone is not sufficient protection for its files.
- Map selected assets and included folders into repository-relative paths.
  Reuse existing image transformations and accept manually prepared variants.
- Separate updating dependencies from consuming them. An explicit update resolves
  the desired asset set; a production build consumes the locked result.
- Lock membership, output paths, source versions, and transformation settings.
  Once templates affect outputs, their resolved recipe must be locked as well.
- Preserve local edits, report conflicts and planned changes, and make deletion
  explicit. Support unattended CI with appropriately scoped credentials.
- Distinguish immutable version links from mutable current-version links.
  Public delivery is intentional, and external caches may delay visible changes.

Acceptance scenario:

1. Connect a real source set to the app and website, including both a selected
   file mapping and a folder inclusion rule.
2. Build both projects and record their resolved assets in version control.
3. Replace source artwork and add a file to the included folder.
4. Rebuild the old commits: neither the artwork nor file set changes.
5. Intentionally update the website. Review and commit the changed asset set;
   the application remains unchanged until its own update.
6. Rebuild an older release with its original assets, provided those versions
   have not been explicitly deleted.

Initial onboarding may require consolidating duplicate files or changing inline
SVGs to a shared project reference. Varda does not automatically refactor consuming
applications. Pulling files also does not update an already installed mobile app
or publish a store listing.

## Next: templates with useful previews

Start with the app-and-web workflow, then extend to App Store / Google Play
materials and other repeated uses. A template can define:

- Required and optional inputs, including separately composed artwork.
- Output dimensions, formats, transparency, names, and paths.
- Preview contexts, masks, backgrounds, and safe-area / clear-space guides.
- Machine-checkable requirements, recommendations, and manual review steps.
- A version and the platform requirements or compatibility assumptions it follows.

Templates should support team-authored recipes and community sharing. Updating a
shared template must not silently alter existing project outputs. Community
recipes need explicit reuse licensing and must not include private brand assets.

A preview is a simulation, not a guarantee of appearance on every device or store
approval. Resizing cannot replace composition work. Start with declarative recipes
and existing transformations, not a general-purpose design editor or executable
community plugins.

## Later: usage monitoring

Monitor explicitly configured first-party and selected external URLs, not the
entire internet. Combine two layers:

1. Compare accessible page assets against known current and historical outputs.
2. Use rendered-page visual comparison to flag possible matches when direct file
   comparison is insufficient, including embedded or modified artwork.

Every finding should include evidence, the inspected URL, the check time, and its
certainty: **confirmed outdated**, **possible outdated use**, or **not verified**.
A blocked page, login requirement, or inconclusive scan is not a clean result.
Respect access restrictions and report scan coverage; never claim all old logos
have been found. Start with notifications, not automatic third-party edits.

For destinations accepting image URLs, offer suitable shared links. For upload-only
services, provide ready-to-upload files. Native publishing integrations are separate
work and should reuse established tools where possible.

## Boundaries and validation

Do not make the first milestone depend on a template marketplace, visual crawler,
full design editor, store publisher, or enterprise approval workflow.
Generic digital-file delivery is part of the intended direction, but the current
implementation accepts images and videos. Choose the first additional formats
from real workflows rather than promising previews or transformations for every
file.

The repository already has much of the foundation: asset versions, Vards, image
transformations, CLI sync, API/MCP access, and S3-compatible deployment. The CLI
now provides schema 2 snapshots and `pull --frozen` for locked membership, paths,
versions, transformation URLs and verified bytes, subject to retention, signing
and delivery availability. Per-asset visibility now gates originals and variants;
new files are private and anonymous public Vards fail closed if any mapped file
is private. Previously downloaded or publicly cached copies cannot be revoked.
The implemented folder-inclusion slice adds bounded literal recursive prefix rules
alongside manual mappings, with separate editable configuration and a live resolved
preview in the existing editor and MCP. Ready current originals generate read-only
outputs; empty/root/nonexistent folders are valid. Collisions and total-output
limits fail resolution but leave configuration repairable. Normal pull intentionally
adopts membership changes; frozen builds do not. Rule removal needs `--delete` on
the updating pull for tracked local cleanup; a no-delete update loses stale tracking.
See the [workflow and limits](../README.md#recursive-folder-inclusion) and
[migration constraints](operations.md#folder-rule-upgrade).
These bounded delivery and folder slices do not complete the broader milestone,
templates, or real Musubi acceptance scenario above. Browser visual acceptance and
real-project adoption still need verification; there is no background watcher.

Success means the second brand update avoids repeated requirements research,
export setup, and copying while preserving independent releases. Measure the
manual steps, mistakes, and time against the team's previous workflow.

Validate with Musubi, then at least two other small teams or agencies. The personal
case demonstrates a problem, not proven market demand or willingness to pay.
Still to decide: hosted-service and self-hosting priorities, commercial offering,
initial non-media formats, template authoring/sharing UX, and monitoring budgets.
MIT open-source licensing is a commitment, not an unresolved business-model choice.
