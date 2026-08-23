import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type SyntheticEvent } from "react";
import {
  createVard,
  deleteVard,
  getVard,
  listAssets,
  listSyncAssets,
  listVards,
  replaceVardItems,
  updateVard,
  type AssetSummary,
  type TransformationInput,
} from "./asset-api";
import {
  FolderBreadcrumbs,
  useCloseDetailsOnOutsideClick,
} from "./asset-dashboard";
import { ConfirmDialog } from "./confirm-dialog";
import { Modal } from "./modal";

type DraftItem = {
  id: string;
  assetId: string;
  key: string;
  outputPath: string;
  versionId: string | null;
  transformation: TransformationInput | null;
  writable: boolean;
};

export function VardsPage({
  workspaceId,
  workspaceName,
  canEdit,
}: {
  workspaceId: string;
  workspaceName: string;
  canEdit: boolean;
}) {
  const vards = useQuery({
    queryKey: ["vards", workspaceId],
    queryFn: () => listVards(workspaceId),
  });

  return (
    <main className="dashboard-main settings-page" id="vards">
      <header className="settings-heading with-action">
        <div>
          <h1>Vards</h1>
          <span>Project-specific asset manifests for repositories and CI.</span>
        </div>
        {canEdit && <NewVardForm workspaceId={workspaceId} />}
      </header>

      <div className="settings-stack">
        <section className="settings-panel">
          <header>
            <h2>┌─ {workspaceName.toUpperCase()} VARDS</h2>
            <span>{vards.data?.vards.length ?? 0} TOTAL</span>
          </header>
          {vards.isPending ? (
            <p className="settings-state">Loading Vards…</p>
          ) : vards.isError ? (
            <p className="error-strip settings-inline-error" role="alert">
              {vards.error.message}
            </p>
          ) : vards.data.vards.length ? (
            <ul className="vard-list">
              {vards.data.vards.map((vard) => (
                <li key={vard.id}>
                  <span>
                    <strong>{vard.name}</strong>
                    <small>
                      {vard.isPublic ? "PUBLIC" : "PRIVATE"} // {vard.itemCount}{" "}
                      ITEMS
                    </small>
                  </span>
                  <Link
                    to="/workspaces/$workspaceId/vards/$vardId"
                    params={{ workspaceId, vardId: vard.id }}
                    className="button-link primary-button"
                  >
                    Configure
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-state">└─ No Vards yet</p>
          )}
        </section>
      </div>
    </main>
  );
}

function NewVardForm({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailsRef = useCloseDetailsOnOutsideClick();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setPending(true);
    setError("");
    try {
      const form = new FormData(formElement);
      const vard = await createVard(workspaceId, {
        name: String(form.get("name")),
        isPublic: form.get("isPublic") === "on",
      });
      formElement.reset();
      formElement.closest("details")?.removeAttribute("open");
      await queryClient.invalidateQueries({ queryKey: ["vards", workspaceId] });
      await navigate({
        to: "/workspaces/$workspaceId/vards/$vardId",
        params: { workspaceId, vardId: vard.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vard creation failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <details ref={detailsRef} className="upload-drawer form-drawer">
      <summary>New Vard</summary>
      <form onSubmit={submit}>
        <div className="drawer-row">
          <label>
            Vard name
            <input name="name" placeholder="Website" maxLength={80} required />
          </label>
          <button className="primary-button" disabled={pending}>
            {pending ? "Creating…" : "Create Vard"}
          </button>
        </div>
        <label className="checkbox-label">
          <input type="checkbox" name="isPublic" />
          Public manifest
        </label>
        {error && (
          <p className="error-strip" role="alert">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}

export function VardEditor({
  workspaceId,
  workspaceName,
  vardId,
  canEdit,
}: {
  workspaceId: string;
  workspaceName: string;
  vardId: string;
  canEdit: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const vard = useQuery({
    queryKey: ["vard", workspaceId, vardId],
    queryFn: () => getVard(workspaceId, vardId),
  });
  const assets = useQuery({
    queryKey: ["sync-assets", workspaceId],
    queryFn: () => listSyncAssets(workspaceId),
  });
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [outputPrefix, setOutputPrefix] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  // A picked asset is only a draft until its settings are saved; it joins the
  // Vard on the same write that stores them.
  const [newItem, setNewItem] = useState<DraftItem | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!vard.data) return;
    setName(vard.data.name);
    setIsPublic(vard.data.isPublic);
    setItems(
      vard.data.items.map((item) => ({
        id: item.id,
        assetId: item.assetId,
        key: item.key,
        outputPath: item.outputPath,
        versionId: item.pinned ? item.versionId : null,
        transformation: item.transformation,
        writable: item.writable,
      })),
    );
  }, [vard.data]);

  // Every edit is an explicit act on one file, so each one is written straight
  // through. The API replaces the whole item list, which is why the next state
  // is computed first and sent as a whole.
  async function persistItems(next: DraftItem[]) {
    const previous = items;
    setItems(next);
    setError("");
    setMessage("");
    try {
      await replaceVardItems(
        workspaceId,
        vardId,
        next.map(
          ({ assetId, versionId, outputPath, transformation, writable }) => ({
            assetId,
            versionId,
            outputPath,
            transformation,
            writable,
          }),
        ),
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["vard", workspaceId, vardId],
        }),
        queryClient.invalidateQueries({ queryKey: ["vards", workspaceId] }),
      ]);
      setMessage("Saved");
    } catch (cause) {
      setItems(previous);
      setError(cause instanceof Error ? cause.message : "Vard update failed");
    }
  }

  async function persistManifest(patch: { name?: string; isPublic?: boolean }) {
    setError("");
    setMessage("");
    try {
      await updateVard(workspaceId, vardId, patch);
      await queryClient.invalidateQueries({ queryKey: ["vards", workspaceId] });
      setMessage("Saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vard update failed");
    }
  }

  function addItem(picked: { id: string; key: string; mimeType: string }) {
    const filename = `${picked.key.split("/").pop()}.${extensionFor(picked.mimeType)}`;
    setPickerOpen(false);
    setNewItem({
      id: crypto.randomUUID(),
      assetId: picked.id,
      key: picked.key,
      outputPath: availableOutputPath(`${outputPrefix}${filename}`, items),
      versionId: null,
      transformation: null,
      writable: false,
    });
  }

  async function remove() {
    await deleteVard(workspaceId, vardId);
    await queryClient.invalidateQueries({ queryKey: ["vards", workspaceId] });
    await navigate({
      to: "/workspaces/$workspaceId/vards",
      params: { workspaceId },
    });
  }

  if (vard.isPending || assets.isPending)
    return <div className="loading">Loading Vard…</div>;
  if (vard.isError || assets.isError)
    return (
      <div className="state-panel" role="alert">
        {vard.error?.message ?? assets.error?.message}
      </div>
    );

  const { folders, files } = outputTree(items, outputPrefix);
  const editing = newItem ?? items.find(({ id }) => id === editingId);
  const config = JSON.stringify(
    {
      schema: 1,
      server: window.location.origin,
      workspace: workspaceId,
      vard: vardId,
    },
    null,
    2,
  );

  return (
    <main className="dashboard-main settings-page" id="vard-editor">
      <header className="settings-heading">
        <h1>{vard.data.name}</h1>
        <span>The files this Vard writes into a project, mirrored.</span>
      </header>

      <div className="settings-stack">
        <section className="settings-panel">
          <header>
            <h2>┌─ MANIFEST</h2>
            <span>{isPublic ? "PUBLIC" : "PRIVATE"}</span>
          </header>
          <form onSubmit={(event) => event.preventDefault()}>
            <label>
              Name
              <input
                value={name}
                maxLength={80}
                required
                disabled={!canEdit}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (name && name !== vard.data.name)
                    void persistManifest({ name });
                }}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={isPublic}
                disabled={!canEdit}
                onChange={(event) => {
                  setIsPublic(event.target.checked);
                  void persistManifest({ isPublic: event.target.checked });
                }}
              />
              Public manifest — anyone with its ID can pull these outputs
            </label>
            <div className="settings-url">
              <span>VARD ID</span>
              <code>{vardId}</code>
            </div>
          </form>
        </section>

        <section className="settings-panel">
          <header>
            <h2>┌─ VARDUM.JSON</h2>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(config)}
            >
              Copy
            </button>
          </header>
          <pre className="vard-config">
            <code>{config}</code>
          </pre>
          {!isPublic && (
            <p className="settings-note">
              Private Vards require <code>VARDUM_API_KEY</code> in the CLI
              environment.
            </p>
          )}
        </section>

        <section className="settings-panel">
          <header className="outputs-header">
            <h2>┌─ OUTPUTS</h2>
            <span role="status">
              /{outputPrefix} // {items.length} FILES
              {message && ` // ${message}`}
            </span>
            {canEdit && (
              <button type="button" onClick={() => setPickerOpen(true)}>
                Add asset
              </button>
            )}
          </header>

          {outputPrefix || folders.length || files.length ? (
            <div className="vard-tree folder-grid">
              {outputPrefix && (
                <button
                  className="folder-open"
                  type="button"
                  onClick={() =>
                    setOutputPrefix(outputPrefix.replace(/[^/]+\/$/, ""))
                  }
                >
                  <span aria-hidden="true">▱</span> ..
                </button>
              )}
              {folders.map((folder) => (
                <button
                  key={folder.prefix}
                  className="folder-open"
                  type="button"
                  onClick={() => setOutputPrefix(folder.prefix)}
                >
                  <span aria-hidden="true">▱</span> {folder.name}
                  <small>{folder.count}</small>
                </button>
              ))}
              {files.map((item) => (
                <button
                  key={item.id}
                  className="folder-open vard-file"
                  type="button"
                  onClick={() => setEditingId(item.id)}
                >
                  <span aria-hidden="true">▤</span>
                  {item.outputPath.slice(outputPrefix.length)}
                  <small>{itemBadge(item)}</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="settings-state">
              └─{" "}
              {items.length
                ? "This folder holds no files"
                : "Add the first asset output"}
            </p>
          )}

          {error && (
            <p className="error-strip settings-inline-error" role="alert">
              {error}
            </p>
          )}
        </section>

        {canEdit && (
          <section className="settings-panel danger-zone">
            <header>
              <h2>┌─ DELETE VARD</h2>
              <span>IRREVERSIBLE</span>
            </header>
            <div className="panel-action-row">
              <p>Deletes this manifest only. Assets remain untouched.</p>
              <button
                className="danger-button"
                type="button"
                onClick={() => setDeleteOpen(true)}
              >
                Delete Vard
              </button>
            </div>
          </section>
        )}
      </div>

      {editing && (
        <VardItemDialog
          key={editing.id}
          item={editing}
          isNew={Boolean(newItem)}
          source={assets.data.assets.find(({ id }) => id === editing.assetId)}
          canEdit={canEdit}
          onClose={() => {
            setEditingId("");
            setNewItem(null);
          }}
          onSave={(next) => {
            setEditingId("");
            setNewItem(null);
            void persistItems(
              newItem
                ? [...items, next]
                : items.map((current) =>
                    current.id === next.id ? next : current,
                  ),
            );
          }}
          onRemove={() => {
            setEditingId("");
            if (newItem) return setNewItem(null);
            void persistItems(items.filter(({ id }) => id !== editing.id));
          }}
        />
      )}

      <AssetPickerDialog
        open={pickerOpen}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        destination={outputPrefix}
        addedAssetIds={new Set(items.map(({ assetId }) => assetId))}
        onPick={addItem}
        onClose={() => setPickerOpen(false)}
      />

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete “${vard.data.name}”?`}
        description="The Vard manifest will be deleted. Workspace assets are not affected."
        confirmLabel="Delete Vard"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={remove}
      />
    </main>
  );
}

function VardItemDialog({
  item,
  isNew,
  source,
  canEdit,
  onSave,
  onRemove,
  onClose,
}: {
  item: DraftItem;
  isNew: boolean;
  source?: { versionId: string; mimeType: string };
  canEdit: boolean;
  onSave: (item: DraftItem) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(item);
  const transformed = Boolean(draft.transformation);

  function change(patch: Partial<DraftItem>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  return (
    <Modal open label={`Settings for ${item.outputPath}`} onClose={onClose}>
      <div className="panel-dialog-content">
        <header>
          <span>
            <strong>{draft.outputPath}</strong>
            <small>
              {item.key} // {source?.mimeType ?? "Unavailable asset"}
            </small>
          </span>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="vard-item-fields">
          <label>
            Output path
            <input
              value={draft.outputPath}
              required
              disabled={!canEdit}
              onChange={(event) => change({ outputPath: event.target.value })}
            />
          </label>
          <label>
            Format
            <select
              value={draft.transformation?.format ?? "original"}
              disabled={!canEdit}
              onChange={(event) => {
                const format = event.target.value;
                change({
                  writable: false,
                  transformation:
                    format === "original"
                      ? null
                      : {
                          ...draft.transformation,
                          format: format as NonNullable<
                            TransformationInput["format"]
                          >,
                        },
                });
              }}
            >
              <option value="original">Original</option>
              <option value="avif">AVIF</option>
              <option value="jpeg">JPEG</option>
              <option value="png">PNG</option>
              <option value="webp">WebP</option>
            </select>
          </label>
          <label>
            Width
            <input
              type="number"
              min={1}
              max={4096}
              disabled={!canEdit || !transformed}
              value={draft.transformation?.w ?? ""}
              onChange={(event) =>
                change({
                  transformation: draft.transformation
                    ? {
                        ...draft.transformation,
                        w: numberOrUndefined(event.target.value),
                      }
                    : null,
                })
              }
            />
          </label>
          <label>
            Height
            <input
              type="number"
              min={1}
              max={4096}
              disabled={!canEdit || !transformed}
              value={draft.transformation?.h ?? ""}
              onChange={(event) =>
                change({
                  transformation: draft.transformation
                    ? {
                        ...draft.transformation,
                        h: numberOrUndefined(event.target.value),
                      }
                    : null,
                })
              }
            />
          </label>
          <label>
            Fit
            <select
              value={draft.transformation?.fit ?? "inside"}
              disabled={
                !canEdit ||
                !transformed ||
                (!draft.transformation?.w && !draft.transformation?.h)
              }
              onChange={(event) =>
                change({
                  transformation: draft.transformation
                    ? {
                        ...draft.transformation,
                        fit: event.target.value as TransformationInput["fit"],
                      }
                    : null,
                })
              }
            >
              <option value="inside">Inside</option>
              <option value="cover">Cover</option>
              <option value="contain">Contain</option>
              <option value="fill">Fill</option>
              <option value="outside">Outside</option>
            </select>
          </label>
          <label>
            Quality
            <input
              type="number"
              min={1}
              max={100}
              disabled={!canEdit || !transformed}
              value={draft.transformation?.q ?? ""}
              onChange={(event) =>
                change({
                  transformation: draft.transformation
                    ? {
                        ...draft.transformation,
                        q: numberOrUndefined(event.target.value),
                      }
                    : null,
                })
              }
            />
          </label>
        </div>

        <div className="vard-item-options">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={Boolean(draft.versionId)}
              disabled={!canEdit || !source || transformed || draft.writable}
              onChange={(event) =>
                change({
                  versionId: event.target.checked
                    ? (source?.versionId ?? null)
                    : null,
                })
              }
            />
            Pin current version
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.writable}
              disabled={!canEdit || transformed || Boolean(draft.versionId)}
              onChange={(event) => change({ writable: event.target.checked })}
            />
            Writable by <code>vardum push</code>
          </label>
        </div>

        {canEdit && (
          <footer className="panel-dialog-actions">
            <button className="danger-button" type="button" onClick={onRemove}>
              {isNew ? "Discard" : "Remove"}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!draft.outputPath}
              onClick={() => onSave(draft)}
            >
              {isNew ? "Add file" : "Save file"}
            </button>
          </footer>
        )}
      </div>
    </Modal>
  );
}

function itemBadge(item: DraftItem) {
  if (item.transformation)
    return (item.transformation.format ?? "resized").toUpperCase();
  if (item.versionId) return "PINNED";
  return item.writable ? "PUSH" : "LATEST";
}

function AssetPickerDialog({
  open,
  onClose,
  ...picker
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string;
  destination: string;
  addedAssetIds: Set<string>;
  onPick: (asset: { id: string; key: string; mimeType: string }) => void;
}) {
  return (
    <Modal open={open} label="Add an asset output" onClose={onClose}>
      <div className="panel-dialog-content">
        <header>
          <h2>┌─ ADD ASSET</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <AssetPicker {...picker} />
      </div>
    </Modal>
  );
}

function AssetPicker({
  workspaceId,
  workspaceName,
  destination,
  addedAssetIds,
  onPick,
}: {
  workspaceId: string;
  workspaceName: string;
  destination: string;
  addedAssetIds: Set<string>;
  onPick: (asset: { id: string; key: string; mimeType: string }) => void;
}) {
  const [prefix, setPrefix] = useState("");
  const browse = useQuery({
    queryKey: ["assets", workspaceId, prefix],
    queryFn: () => listAssets(workspaceId, prefix),
  });
  const folders = browse.data?.folders ?? [];
  const assets = browse.data?.assets ?? [];

  return (
    <div className="vard-picker">
      <div className="vard-picker-bar">
        <FolderBreadcrumbs
          workspaceName={workspaceName}
          prefix={prefix}
          onNavigate={setPrefix}
        />
        <span>→ /{destination}</span>
      </div>
      {browse.isPending ? (
        <p className="settings-state">Loading assets…</p>
      ) : browse.isError ? (
        <p className="error-strip settings-inline-error" role="alert">
          {browse.error.message}
        </p>
      ) : folders.length || assets.length ? (
        <>
          {folders.length > 0 && (
            <div className="folder-grid">
              {folders.map((folder) => (
                <button
                  key={folder.prefix}
                  className="folder-open"
                  type="button"
                  onClick={() => setPrefix(folder.prefix)}
                >
                  <span aria-hidden="true">▱</span> {folder.name}
                </button>
              ))}
            </div>
          )}
          {assets.length > 0 && (
            <ul className="vard-picker-grid">
              {assets.map((asset) => (
                <PickerAsset
                  key={asset.id}
                  asset={asset}
                  added={addedAssetIds.has(asset.id)}
                  onPick={onPick}
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="settings-state">└─ This folder is empty</p>
      )}
    </div>
  );
}

function PickerAsset({
  asset,
  added,
  onPick,
}: {
  asset: AssetSummary;
  added: boolean;
  onPick: (asset: { id: string; key: string; mimeType: string }) => void;
}) {
  const ready = Boolean(asset.currentVersionId);
  return (
    <li>
      <button
        className="vard-picker-asset"
        type="button"
        disabled={!ready}
        title={ready ? `Add ${asset.key} as an output` : "Asset is not ready"}
        onClick={() =>
          onPick({
            id: asset.id,
            key: asset.key,
            mimeType: asset.mimeType ?? "",
          })
        }
      >
        <span className="asset-preview">
          {asset.thumbnailUrl ? (
            <img src={asset.thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="asset-preview-placeholder">
              {asset.status ?? "empty"}
            </span>
          )}
          {added && <span className="asset-status">In Vard</span>}
        </span>
        <span className="vard-picker-name">{asset.displayName}</span>
        <span className="vard-picker-meta">
          {asset.mimeType?.replace("image/", "").toUpperCase() ?? "—"}
        </span>
      </button>
    </li>
  );
}

// The Vard's own output paths, browsed as the directory tree `vardum pull` writes.
function outputTree(items: DraftItem[], prefix: string) {
  const folders = new Map<string, number>();
  const files: DraftItem[] = [];
  for (const item of items) {
    if (!item.outputPath.startsWith(prefix)) continue;
    const remainder = item.outputPath.slice(prefix.length);
    const slash = remainder.indexOf("/");
    if (slash === -1) files.push(item);
    else {
      const name = remainder.slice(0, slash);
      folders.set(name, (folders.get(name) ?? 0) + 1);
    }
  }
  return {
    folders: [...folders]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count, prefix: `${prefix}${name}/` })),
    files: files.sort((left, right) =>
      left.outputPath.localeCompare(right.outputPath),
    ),
  };
}

// Clicking the same asset twice would otherwise collide on the per-Vard unique output path.
function availableOutputPath(candidate: string, items: DraftItem[]) {
  const taken = new Set(items.map(({ outputPath }) => outputPath));
  if (!taken.has(candidate)) return candidate;
  const [, base, extension] = candidate.match(/^(.*?)(\.[^./]*)?$/) ?? [];
  for (let suffix = 2; ; suffix += 1) {
    const next = `${base}-${suffix}${extension ?? ""}`;
    if (!taken.has(next)) return next;
  }
}

function extensionFor(mimeType: string) {
  return (
    {
      "image/avif": "avif",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/svg+xml": "svg",
      "image/webp": "webp",
    }[mimeType] ?? "bin"
  );
}

function numberOrUndefined(value: string) {
  return value ? Number(value) : undefined;
}
