# Known asset use

The workspace's **Usage** page records projects and destinations you explicitly
know about. It is a private inventory, available to workspace readers. It does
not discover websites, count every use or establish what is currently deployed.
Delivery statistics are separate.

## Register a project

1. Choose **Register consumer**, name the consumer, and declare whether it is a
   first-party project or a selected external destination.
2. Add concrete HTTP or HTTPS destination URLs and labels. These identify where
   you expect the artwork to be used. Saving a URL does not fetch it or verify
   ownership; do not include credentials or secret links.
3. Link a destination to an asset or a specific resolved Vard output. The
   selection includes outputs produced by folder rules. The link preserves
   asset identity and output path so a different file appearing at that path
   cannot silently take over an existing reference.
4. Choose the consumer's update mode for each link:

| Mode | Expected effect of a source change |
| --- | --- |
| Live URL | A consumer using a current public URL can receive the new artwork after relevant caches expire. This record does not publish a private asset or prove the destination uses that URL. |
| Manual frozen | The project's recorded files remain unchanged until someone intentionally updates its snapshot and releases the project. |
| Opt-in PR | A preference for reviewed repository updates. Registering it does not connect GitHub, open a PR or authorize automatic changes. |

A new record starts **Not manually checked**. Creating or editing it, resolving
a manifest, and uploading a new asset version do not count as checking the
consumer.

Folder rules with explicit use inclusion can supply these targets too. A generated
use target retains its canonical source asset and output path while its scope
also captures the linked use identity and effective recipe. A different use at the
same path is a scope change even when its source and settings match. Removing a
folder-only use leaves that target unresolved; another output cannot silently
take over its recorded observation. Changing the recipe changes the scope;
changing only the current source version reports a source change.

## Record a manual check

Inspect the actual destination or its committed release/snapshot, then use
**Record check** on the corresponding link. Supply the time of that inspection
and the source version you observed. You may also record a commit, release or
short note. Vardum records the authenticated author and keeps the report's
source and destination scope as a snapshot.

This is a human-reported observation. Vardum does not read an external lockfile,
fetch a destination, verify a deployment or attest its output bytes. The
reported source checksum belongs to the source file; transformed output bytes
are independently verified by the CLI's frozen snapshot workflow.

The page keeps the current source separate from the reported version:

- **Not manually checked:** no report is recorded for this link.
- **Matches recorded source:** the source version and output configuration match
  the report's scope. This does not establish that the destination still serves
  those files.
- **Source changed since recorded check:** the resolved source differs from the
  report. Whether a live URL has refreshed or a frozen project has released
  remains unknown until another inspection.
- **Scope changed:** the destination URL, target, output configuration or update
  mode changed. The prior report remains recognizable but does not apply to
  the new scope.
- **Unresolved:** the source was deleted, rebound, or is unavailable. Existing
  reports are retained; there is no substitution with another asset or version.

History pages show the most recently recorded reports first. The date of the
manual inspection remains separate from when the report was recorded. Use
**Older versions** to select a ready source outside the first version page;
paging does not fill the observed version or date for you.

Counts describe only registered records and the displayed known coverage.
They are not a percentage of all real-world asset use. A check's date belongs
only to that explicit observation, never to an automatic whole-project audit.

## Editing and rollout

Workspace editors and owners can register, edit and remove records; viewers can
read them. API keys use the existing workspace asset read/create/update/delete
permissions. Inventory responses use private, non-storeable caching even when
an associated Vard or asset is public. Nothing appears in public manifests.

The inventory is bounded to 200 consumers per workspace, 20 destinations and
100 bindings per consumer, and 1,000 immutable reports per consumer. A request
resolves at most 100 distinct Vards; an inventory page may contain fewer
consumers than its requested row limit. Cursors still advance, and the UI loads
all bounded pages before displaying coverage. Whole-Vard output collision and
size checks still apply, even when only one output is bound.

Edits use an independent revision. If another person changes a record, reload
it and reconcile the saved version with your draft before retrying; a stale
write must not replace their work. Deleting an asset or Vard leaves its usage
reference unresolved. Removing the inventory record removes its reports; it
does not delete the source artwork or change a project's files.

Deployment requires the new tracked application migration through the existing
one-shot migrator and matching API and gateway builds. Back up before upgrading
and follow the [operations procedure](operations.md). This source feature does
not complete server/provider acceptance or the Musubi pilot. Visual change
review, repository automation and URL monitoring remain separate roadmap work
(VARD-85, VARD-86 and VARD-29/30).
