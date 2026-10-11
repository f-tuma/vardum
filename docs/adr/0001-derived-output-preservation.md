# ADR 0001: Preserve transformed output bytes before promising reconstruction

Status: accepted conservative contract, 2026-10-11 (VARD-82).

This decision documents the existing legacy behavior and sets the gate for future
retention and locked recipes. It does not add a derivative ledger, renderer-aware
output identity, historical renderer runner, schema change or garbage collector.
VARD-26 owns the eventual immutable preset/Template and compatible snapshot
implementation. VARD-83 owns any measured eager-generation workflow. Completing
this ADR and its failure proof does not authorize automatic derivative deletion.

## Context

A project can commit a schema 2 `.vardum.lock`, stop using the live Vard, and rebuild
later. The server cannot enumerate all historical lockfiles in external
repositories. Current Vard membership, recent delivery events and absence of known
consumers therefore cannot establish that a transformed output is unused.

A retained original and canonical transformation describe the source and requested
operations. They do not contain the encoder implementation and its defaults, nor
do they guarantee that a different renderer will reproduce the same encoded bytes.
Equal decoded pixels also do not imply equal SHA-256 hashes. This matters even when
a source version and requested dimensions/format/quality have not changed.

## Existing behavior, without an archival promise

### Originals

Ingest computes the original SHA-256 and stores it on the source version. Rendering
reads those bytes without replacing the original. Ready versions have no
application age-based cleanup. Original retention still depends on reachable
storage, operator backup/lifecycle policy and authorized explicit deletion.
Restoring a version changes the current pointer; it does not re-encode its bytes.

### Retained legacy derivatives

`image-variant.ts` uses:

```text
canonical = canonicalizeTransformation(spec)
hash = sha256("v1:" + canonical)
derived/v1/{sourceVersionUuid}/{hash}.{outputExtension}
```

The `v1` prefix identifies the legacy cache contract, not a recorded renderer
revision. A cache hit returns the stored object. A missing object (`NoSuchKey` or
HTTP 404) is rendered with the installed Sharp/native encoder and written to that
same key. Other storage failures are not treated as cache misses. The object PUT
is unconditional; there is no retained output checksum or publish-once ledger.
Mixed renderer revisions across replicas can therefore race on a miss. The
process-local generation map and database transform-capacity slots do not provide
a distributed lock for each output. Stored legacy cache-object existence alone is
not an immutable-publication guarantee.

There is no application derivative age-based GC or retention-reference ledger.
The worker's 90-day retention deletes delivery analytics events, not image
objects. A stored derivative can supply its exact bytes while it remains intact,
reachable and authorized, even if its original object is unavailable. Cache loss
is different: regeneration may produce different bytes at the same legacy URL.

### Legacy URLs, signatures and schema 2

Keep existing v1 cache keys, canonicalization, URL generation and HMAC semantics
unchanged. The HMAC authenticates `workspaceSlug/key?canonicalSpec`; it does not
bind a renderer revision or source version UUID and has no built-in expiration.
A valid transformation signature does not grant access to a private asset.
Private requests still require current workspace read access before cache reads.

Version delivery still looks up the live workspace slug and asset key. The current
asset rename API changes only display name and preserves that key. Actual source
key/slug changes, server-origin changes, signing-secret rotation, revoked access
and explicit deletion can invalidate historical snapshots despite retained bytes.
The separate VARD-14 identity/schema draft is not shipped by this decision.

Schema 2 records source version, membership, output paths, a download URL,
fingerprint and SHA-256 of the downloaded output. The manifest fingerprint is the
source version plus canonical parameters; it does not identify renderer changes.
Frozen pull uses the snapshot without a live manifest, verifies every downloaded
output before writing that file, and leaves the lock unchanged. `--force` does not
bypass checksum verification. Matching local files may need no download. A later
failure can leave earlier verified files restored; frozen pull is not a transaction
across all output files.

A public response's one-year `immutable` cache directive does not make a missing
legacy derivative byte-reconstructible or guarantee server availability. Existing
public cached/downloaded copies cannot be recalled by changing access or deleting
the source.

## Decision

### Retain bytes conservatively

Do not introduce or recommend automatic deletion of derived objects based on age,
last access, current Vard membership or zero known references. Preserve originals
and stored derivatives conservatively until authorized explicit deletion. This
policy does not prove the provider is configured correctly or promise permanent
storage, availability or erasure of downstream copies.

The earlier derived-only lifecycle recommendation in the resource-budget runbook
and its historical readiness checkpoint is superseded by this decision. Original
quotas remain reservation accounting, not total bucket accounting. Continue
monitoring derived/storage growth; reaching a storage limit is a reason to choose
an explicit retention model, not to silently discard locked outputs.

### Separate retained output from regeneration

For current legacy delivery, keep the cache-miss behavior described above and the
frozen client's fail-closed digest verification. Do not present retaining originals
as evidence that transformed historical locks can always be rebuilt.

For a future contract promising immutable locked outputs, the authoritative result
is the retained encoded object and its expected SHA-256. Restore matching retained
bytes when available. Regeneration is permitted only through an explicitly
identified historical renderer and resolved recipe, with the result checked
against that expected SHA-256 before publication or consumer replacement. If the
renderer is unavailable or the digest differs, report the output unavailable;
never substitute latest rendering, silently re-lock, or bypass the checksum.

No such server-side retained-output mechanism is implemented here. The current
server can return changed regenerated bytes; the schema 2 frozen client rejects
them. The future server must enforce its stronger promise itself.

### Identify renderer and recipe independently

Future locked recipes must record an immutable renderer revision that covers the
rendering code and resolved defaults, Sharp and native encoder dependency bundle,
execution artifact and relevant platform. A package version alone is insufficient;
record artifact/dependency integrity and runtime version evidence. A renderer
revision is provenance, not proof of deterministic reproduction: only a matching
output digest establishes that the reproduced bytes meet the lock.

A preset/Template revision is a separate immutable recipe input. Resolve its full
canonical operations, source versions, overlays/focal values if used, dimensions,
format, quality and other output-affecting defaults before locking. Do not resolve
`latest`, `Accept`, mutable metadata or heuristics during a frozen rebuild. A change
to either recipe or renderer must create a distinct output identity and be adopted
through an intentional consumer update; it must not overwrite a previously
promised immutable output. Future publication must enforce write-once or
compare-and-set against authoritative output identity and expected digest, handle
competing writers/renderer revisions, and reject replacement of committed bytes.
Selecting and proving that mechanism is downstream work, not a current-cache
guarantee.

VARD-26 must select and test the concrete identity, publication and compatible
wire/snapshot design before production locked recipe outputs are offered. Preserve
legacy clients and signatures during that work. This ADR does not define an active
new endpoint, add fields to schema 2 or activate the VARD-14 draft.

### Explicit deletion and possible retention references

Authorized asset deletion currently cascades source versions/mappings and queues
original keys plus each legacy `derived/v1/{version}/` prefix for removal. Workspace
deletion also queues its object cleanup. A historical external lock does not block
these actions. Subsequent server delivery is unavailable; downstream public copies
and in-flight work are not an erasure guarantee. Removing a Vard or its membership
alone does not remove retained source assets. There is no standalone retained
version-delete contract added by this ADR.

A future opt-in retention-reference mechanism may record known consumer snapshots
and their explicit release/removal. It must distinguish declared references from a
complete inventory and preserve tenant/private authorization. No known references
must never imply that unregistered or historical external locks no longer exist.
Legacy outputs remain conservatively retained unless an explicit, accepted
migration/retention model addresses those consumers.

Automatic GC requires a separately accepted retention model, reconstruction or
retained-archive proof, consumer/deletion semantics, and failure acceptance. This
ADR's completion alone is insufficient. Derivative ledger, reference lifecycle,
quotas for retained outputs, distributed publication and eager status are future
implementation decisions, not shipped capabilities.

## Failure proof and limits

`derivative-preservation.fixture.ts` runs inside the existing `test:private-delivery`
disposable PostgreSQL/local fake-S3 fixture, with real authorization, legacy routes,
current rendering and CLI. It never reads `.env` or configured production services.

The proof creates valid PNG output with a controlled different compression default
under the same canonical request. It asserts equal decoded pixels and different
encoded SHA-256 values. This simulates an encoder-default revision; it does not
claim that a particular historical Sharp/libvips upgrade produced those bytes.

It locks the retained output through normal pull, proves private cached delivery
with the original absent and anonymous denial, deletes the live Vard and only the
cache object, and lets the actual current renderer regenerate. Frozen `--force`
then fails before replacing the affected file, with its existing file and exact
lock unchanged. Restoring the retained matching object repairs frozen delivery.
A missing original plus missing derivative returns a non-cacheable error and
preserves the frozen file/lock. Same-runtime regeneration is checked for this
fixture only, not asserted deterministic for all media or platforms.

Run from a clean dependency installation as an unprivileged user:

```sh
PG_BINDIR=/path/to/native/postgresql/bin pnpm --filter @vardum/api test:private-delivery
```

The fixture proves the current failure boundary. It does not prove production
provider lifecycle settings, historical renderer availability, distributed
publication, new recipe/schema compatibility, off-host backup durability or a
backend release/deployment. Those retain their own acceptance gates.
