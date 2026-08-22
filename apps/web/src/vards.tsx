import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type SyntheticEvent } from "react";
import {
  createVard,
  deleteVard,
  getVard,
  listSyncAssets,
  listVards,
  replaceVardItems,
  updateVard,
  type TransformationInput,
} from "./asset-api";
import { ConfirmDialog } from "./confirm-dialog";

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const vards = useQuery({
    queryKey: ["vards", workspaceId],
    queryFn: () => listVards(workspaceId),
  });

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const vard = await createVard(workspaceId, {
        name: String(form.get("name")),
        isPublic: form.get("isPublic") === "on",
      });
      formElement.reset();
      await queryClient.invalidateQueries({ queryKey: ["vards", workspaceId] });
      await navigate({
        to: "/workspaces/$workspaceId/vards/$vardId",
        params: { workspaceId, vardId: vard.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vard creation failed");
    }
  }

  return (
    <main className="dashboard-main settings-page" id="vards">
      <header className="settings-heading">
        <p>WORKSPACE // VARDS</p>
        <h1>Vards</h1>
        <span>Project-specific asset manifests for repositories and CI.</span>
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

        {canEdit && (
          <section className="settings-panel">
            <header>
              <h2>┌─ NEW VARD</h2>
              <span>PROJECT MANIFEST</span>
            </header>
            <form onSubmit={create}>
              <label>
                Name
                <input name="name" maxLength={80} required />
              </label>
              <label className="checkbox-label">
                <input name="isPublic" type="checkbox" />
                Public manifest — no API key required for pull
              </label>
              {error && (
                <p className="error-strip" role="alert">
                  {error}
                </p>
              )}
              <button className="primary-button">Create Vard</button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}

export function VardEditor({
  workspaceId,
  vardId,
  canEdit,
}: {
  workspaceId: string;
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
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
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

  useEffect(() => {
    if (!selectedAssetId && assets.data?.assets[0])
      setSelectedAssetId(assets.data.assets[0].id);
  }, [assets.data, selectedAssetId]);

  function addItem() {
    const selected = assets.data?.assets.find(
      ({ id }) => id === selectedAssetId,
    );
    if (!selected) return;
    setItems((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        assetId: selected.id,
        key: selected.key,
        outputPath: `${selected.key}.${extensionFor(selected.mimeType)}`,
        versionId: null,
        transformation: null,
        writable: false,
      },
    ]);
  }

  function changeItem(id: string, patch: Partial<DraftItem>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function save() {
    if (!vard.data) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await updateVard(workspaceId, vardId, { name, isPublic });
      await replaceVardItems(
        workspaceId,
        vardId,
        items.map(
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
      setMessage("Vard saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vard update failed");
    } finally {
      setPending(false);
    }
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
        <p>WORKSPACE // VARDS // CONFIGURE</p>
        <h1>{vard.data.name}</h1>
        <span>Select assets, output paths and delivery variants.</span>
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
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={isPublic}
                disabled={!canEdit}
                onChange={(event) => setIsPublic(event.target.checked)}
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
          <header>
            <h2>┌─ OUTPUTS</h2>
            <span>{items.length} ITEMS</span>
          </header>
          {canEdit && (
            <div className="vard-add-item">
              <label>
                Asset
                <select
                  value={selectedAssetId}
                  onChange={(event) => setSelectedAssetId(event.target.value)}
                >
                  {assets.data.assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.key}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!selectedAssetId}
                onClick={addItem}
              >
                Add output
              </button>
            </div>
          )}

          {items.length ? (
            <div className="vard-items">
              {items.map((item) => {
                const source = assets.data.assets.find(
                  ({ id }) => id === item.assetId,
                );
                const transformed = Boolean(item.transformation);
                return (
                  <article className="vard-item" key={item.id}>
                    <header>
                      <span>
                        <strong>{item.key}</strong>
                        <small>{source?.mimeType ?? "Unavailable asset"}</small>
                      </span>
                      {canEdit && (
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() =>
                            setItems((current) =>
                              current.filter(({ id }) => id !== item.id),
                            )
                          }
                        >
                          Remove
                        </button>
                      )}
                    </header>
                    <div className="vard-item-fields">
                      <label>
                        Output path
                        <input
                          value={item.outputPath}
                          required
                          disabled={!canEdit}
                          onChange={(event) =>
                            changeItem(item.id, {
                              outputPath: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Format
                        <select
                          value={item.transformation?.format ?? "original"}
                          disabled={!canEdit}
                          onChange={(event) => {
                            const format = event.target.value;
                            changeItem(item.id, {
                              writable: false,
                              transformation:
                                format === "original"
                                  ? null
                                  : {
                                      ...item.transformation,
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
                          value={item.transformation?.w ?? ""}
                          onChange={(event) =>
                            changeItem(item.id, {
                              transformation: item.transformation
                                ? {
                                    ...item.transformation,
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
                          value={item.transformation?.h ?? ""}
                          onChange={(event) =>
                            changeItem(item.id, {
                              transformation: item.transformation
                                ? {
                                    ...item.transformation,
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
                          value={item.transformation?.fit ?? "inside"}
                          disabled={
                            !canEdit ||
                            !transformed ||
                            (!item.transformation?.w && !item.transformation?.h)
                          }
                          onChange={(event) =>
                            changeItem(item.id, {
                              transformation: item.transformation
                                ? {
                                    ...item.transformation,
                                    fit: event.target
                                      .value as TransformationInput["fit"],
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
                          value={item.transformation?.q ?? ""}
                          onChange={(event) =>
                            changeItem(item.id, {
                              transformation: item.transformation
                                ? {
                                    ...item.transformation,
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
                          checked={Boolean(item.versionId)}
                          disabled={
                            !canEdit || !source || transformed || item.writable
                          }
                          onChange={(event) =>
                            changeItem(item.id, {
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
                          checked={item.writable}
                          disabled={
                            !canEdit || transformed || Boolean(item.versionId)
                          }
                          onChange={(event) =>
                            changeItem(item.id, {
                              writable: event.target.checked,
                            })
                          }
                        />
                        Writable by <code>vardum push</code>
                      </label>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="settings-state">└─ Add the first asset output</p>
          )}

          {error && (
            <p className="error-strip settings-inline-error" role="alert">
              {error}
            </p>
          )}
          {canEdit && (
            <div className="settings-actions vard-save-actions">
              <span role="status">{message}</span>
              <button
                className="primary-button"
                disabled={pending}
                onClick={() => void save()}
              >
                {pending ? "Saving…" : "Save Vard"}
              </button>
            </div>
          )}
        </section>

        {canEdit && (
          <section className="settings-panel danger-zone">
            <header>
              <h2>┌─ DELETE VARD</h2>
              <span>IRREVERSIBLE</span>
            </header>
            <div className="vard-delete-row">
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
