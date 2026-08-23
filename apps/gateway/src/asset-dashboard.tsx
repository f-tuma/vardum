import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  createAsset,
  createFolder,
  createTransformationUrl,
  deleteAsset,
  deleteFolder,
  getAsset,
  getAssetDelivery,
  importAssets,
  listAssets,
  listAssetVersions,
  restoreAssetVersion,
  uploadVersion,
  type AssetSummary,
  type TransformationInput,
} from "./asset-api";
import { ConfirmDialog } from "./confirm-dialog";

export function AssetDashboard({
  workspaceId,
  workspaceSlug,
  workspaceName,
  search,
  assetId,
  prefix,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  search: string;
  assetId?: string;
  prefix: string;
}) {
  const navigate = useNavigate();
  const needle = search.trim();
  const [uploadQueue, setUploadQueue] = useState<
    Array<{
      id: string;
      filename: string;
      status: string;
    }>
  >([]);

  function addUpload(id: string, filename: string) {
    setUploadQueue((prev) => [...prev, { id, filename, status: "Starting…" }]);
  }
  function updateUpload(id: string, status: string) {
    setUploadQueue((prev) =>
      prev.map((u) => (u.id === id ? { ...u, status } : u)),
    );
  }
  function removeUpload(id: string) {
    setUploadQueue((prev) => prev.filter((u) => u.id !== id));
  }
  const assets = useQuery({
    // ponytail: one request per keystroke; debounce if a workspace ever makes it show.
    queryKey: ["assets", workspaceId, needle ? "" : prefix, needle],
    queryFn: () => listAssets(workspaceId, needle ? "" : prefix, needle),
    enabled: !assetId,
    refetchInterval: (query) =>
      query.state.data?.assets.some(({ status }) => status === "processing")
        ? 1500
        : false,
  });
  const detail = useQuery({
    queryKey: ["asset", workspaceId, assetId],
    queryFn: () => getAsset(workspaceId, assetId!),
    enabled: Boolean(assetId),
  });
  const filteredAssets = assets.data?.assets ?? [];
  const filteredFolders = assets.data?.folders ?? [];

  function openFolder(nextPrefix: string) {
    void navigate({
      to: "/workspaces/$workspaceId/assets",
      params: { workspaceId },
      search: { prefix: nextPrefix },
    });
  }

  if (assetId) {
    if (detail.isPending)
      return <div className="state-panel">Loading asset…</div>;
    if (detail.isError)
      return (
        <div className="state-panel" role="alert">
          {detail.error.message}
        </div>
      );
    return detail.data ? (
      <AssetDetailPage
        asset={detail.data}
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        fromPrefix={prefix}
      />
    ) : (
      <div className="state-panel" role="alert">
        Asset not found
      </div>
    );
  }

  return (
    <main className="dashboard-main" id="assets">
      <header className="page-heading">
        <div>
          <FolderBreadcrumbs
            workspaceName={workspaceName}
            prefix={prefix}
            onNavigate={openFolder}
          />
          <p>
            {needle
              ? `${filteredAssets.length} matches across every folder`
              : `${filteredFolders.length + filteredAssets.length} items`}
          </p>
        </div>
        <div className="page-actions">
          <ImportForm workspaceId={workspaceId} prefix={prefix} />
          <NewFolderForm workspaceId={workspaceId} prefix={prefix} />
          <NewAssetForm
            workspaceId={workspaceId}
            prefix={prefix}
            onAddUpload={addUpload}
            onUpdateUpload={updateUpload}
            onRemoveUpload={removeUpload}
          />
        </div>
      </header>

      {assets.isPending ? (
        <div className="state-panel">Loading assets…</div>
      ) : assets.isError ? (
        <div className="state-panel" role="alert">
          {assets.error.message}
        </div>
      ) : filteredFolders.length || filteredAssets.length ? (
        <>
          {filteredFolders.length > 0 && (
            <section className="folder-section">
              <h2>Folders</h2>
              <div className="folder-grid">
                {filteredFolders.map((folder) => (
                  <FolderCard
                    key={folder.prefix}
                    folder={folder}
                    workspaceId={workspaceId}
                    onOpen={openFolder}
                  />
                ))}
              </div>
            </section>
          )}
          {filteredAssets.length > 0 && (
            <section className="file-section">
              <h2>Files</h2>
              <ul className="asset-grid">
                {filteredAssets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    workspaceId={workspaceId}
                    workspaceSlug={workspaceSlug}
                    prefix={prefix}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <div className="empty-state">
          <h2>{search ? "No matching assets" : "No assets yet"}</h2>
          <p>
            {search ? "Try another name or key." : "Upload your first asset."}
          </p>
        </div>
      )}
      {uploadQueue.length > 0 && (
        <div className="upload-queue">
          {uploadQueue.map((entry) => (
            <span key={entry.id} className="upload-queue-item">
              {entry.filename}
              <small>{entry.status}</small>
            </span>
          ))}
        </div>
      )}
    </main>
  );
}

function FolderCard({
  folder,
  workspaceId,
  onOpen,
}: {
  folder: { name: string; prefix: string };
  workspaceId: string;
  onOpen: (prefix: string) => void;
}) {
  const queryClient = useQueryClient();
  const menuRef = useCloseDetailsOnOutsideClick();
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    setPending(true);
    setError("");
    try {
      await deleteFolder(workspaceId, folder.prefix);
      await queryClient.invalidateQueries({
        queryKey: ["assets", workspaceId],
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Folder deletion failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="folder-card">
      <button
        className="folder-open"
        type="button"
        onClick={() => onOpen(folder.prefix)}
      >
        <span aria-hidden="true">▱</span> {folder.name}
      </button>
      <details ref={menuRef} className="folder-menu">
        <summary aria-label={`Actions for folder ${folder.name}`}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3" cy="8" r="1.25" />
            <circle cx="8" cy="8" r="1.25" />
            <circle cx="13" cy="8" r="1.25" />
          </svg>
        </summary>
        <div className="folder-menu-popover" role="menu">
          <button
            className="folder-delete"
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() => {
              menuRef.current?.removeAttribute("open");
              setConfirmOpen(true);
            }}
          >
            Delete folder
          </button>
        </div>
      </details>
      {error && (
        <span className="folder-error" role="alert">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete folder “${folder.name}”?`}
        description="This cannot be undone. Folders containing assets or subfolders are protected and cannot be deleted."
        confirmLabel="Delete folder"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={remove}
      />
    </div>
  );
}

export function FolderBreadcrumbs({
  workspaceName,
  prefix,
  onNavigate,
}: {
  workspaceName: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
}) {
  const segments = prefix.split("/").filter(Boolean);
  return (
    <nav className="folder-breadcrumb" aria-label="Folder path">
      <button type="button" onClick={() => onNavigate("")}>
        {workspaceName}
      </button>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`}>
          <span aria-hidden="true">›</span>
          <button
            type="button"
            onClick={() =>
              onNavigate(`${segments.slice(0, index + 1).join("/")}/`)
            }
          >
            {segment}
          </button>
        </span>
      ))}
    </nav>
  );
}

export function useCloseDetailsOnOutsideClick() {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      const details = ref.current;
      if (details?.open && !details.contains(event.target as Node))
        details.open = false;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return ref;
}

function normalizeFolderName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

function ImportForm({
  workspaceId,
  prefix,
}: {
  workspaceId: string;
  prefix: string;
}) {
  const queryClient = useQueryClient();
  const detailsRef = useCloseDetailsOnOutsideClick();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [pending, setPending] = useState(false);

  // The endpoint walks one page per call, so the loop lives here and the user
  // watches the count climb instead of waiting on one long request.
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const source = String(new FormData(formElement).get("source"));
    setPending(true);
    setError("");
    setProgress("");
    try {
      let imported = 0;
      let skipped = 0;
      let token: string | undefined;
      do {
        const page = await importAssets(workspaceId, {
          source,
          prefix,
          token,
        });
        imported += page.imported;
        skipped += page.skipped;
        token = page.nextToken ?? undefined;
        setProgress(`${imported} imported, ${skipped} skipped…`);
      } while (token);
      setProgress(`${imported} imported, ${skipped} skipped`);
      formElement.reset();
      await queryClient.invalidateQueries({
        queryKey: ["assets", workspaceId],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      ref={detailsRef}
      className="upload-drawer folder-drawer quiet-summary"
    >
      <summary>Import from S3</summary>
      <form onSubmit={submit}>
        <label>
          Bucket prefix
          <input
            name="source"
            placeholder="legacy-photos/"
            maxLength={1024}
            required
          />
          <small>
            Objects already in the bucket are copied into this folder and
            ingested. Vardum's own <code>originals/</code> and{" "}
            <code>derived/</code> are refused.
          </small>
        </label>
        {error && (
          <p className="error-strip" role="alert">
            {error}
          </p>
        )}
        <div className="folder-form-actions">
          <span role="status">{progress}</span>
          <button className="primary-button" disabled={pending}>
            {pending ? "Importing…" : "Import"}
          </button>
        </div>
      </form>
    </details>
  );
}

function NewFolderForm({
  workspaceId,
  prefix,
}: {
  workspaceId: string;
  prefix: string;
}) {
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
      await createFolder(
        workspaceId,
        prefix,
        String(new FormData(formElement).get("name")),
      );
      formElement.reset();
      formElement.closest("details")?.removeAttribute("open");
      await queryClient.invalidateQueries({
        queryKey: ["assets", workspaceId, prefix],
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Folder creation failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      ref={detailsRef}
      className="upload-drawer folder-drawer quiet-summary"
    >
      <summary>New folder</summary>
      <form onSubmit={submit}>
        <label>
          Folder name
          <input
            name="name"
            placeholder="Brand Assets"
            maxLength={80}
            onBlur={(event) => {
              event.currentTarget.value = normalizeFolderName(
                event.currentTarget.value,
              );
            }}
            autoFocus
            required
          />
        </label>
        {error && (
          <p className="error-strip" role="alert">
            {error}
          </p>
        )}
        <div className="folder-form-actions">
          <button className="primary-button" disabled={pending}>
            {pending ? "Creating…" : "Create folder"}
          </button>
        </div>
      </form>
    </details>
  );
}

function NewAssetForm({
  workspaceId,
  prefix,
  onAddUpload,
  onUpdateUpload,
  onRemoveUpload,
}: {
  workspaceId: string;
  prefix: string;
  onAddUpload: (id: string, filename: string) => void;
  onUpdateUpload: (id: string, status: string) => void;
  onRemoveUpload: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const detailsRef = useCloseDetailsOnOutsideClick();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Uploading…");
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");

    try {
      if (!(file instanceof File) || !file.size)
        throw new Error("Choose a file");
      const onProgress = (s: string) => {
        setStatus(s);
        onUpdateUpload(uploadId, s);
      };
      const uploadId = crypto.randomUUID();
      onAddUpload(uploadId, file.name);
      // Close the drawer immediately — progress moves to the global queue.
      formElement.closest("details")?.removeAttribute("open");
      const created = await createAsset(workspaceId, {
        key: `${prefix}${String(form.get("key"))}`,
        displayName: String(form.get("displayName")),
      });
      await uploadVersion(workspaceId, created.id, file, onProgress);
      formElement.reset();
      setKeyEdited(false);
      setStatus("Done");
      onUpdateUpload(uploadId, "Done");
      setTimeout(() => onRemoveUpload(uploadId), 5000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
      setStatus("");
    } finally {
      await queryClient.invalidateQueries({
        queryKey: ["assets", workspaceId],
      });
    }
  }

  function generateKey(form: HTMLFormElement, name: string) {
    if (keyEdited) return;
    const key = form.elements.namedItem("key") as HTMLInputElement;
    key.value = name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function inferFields(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    const form = event.currentTarget.form;
    if (!file || !form) return;
    const basename = file.name.replace(/\.[^.]+$/, "");
    const name = form.elements.namedItem("displayName") as HTMLInputElement;
    if (!name.value) name.value = basename;
    generateKey(form, name.value);
  }

  return (
    <details ref={detailsRef} className="upload-drawer">
      <summary>Upload asset</summary>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            Display name
            <input
              name="displayName"
              onChange={(event) => {
                const form = event.currentTarget.form;
                if (form) generateKey(form, event.currentTarget.value);
              }}
              required
            />
          </label>
          <label>
            URL name
            <span className="prefixed-input">
              {prefix && <span className="field-prefix">/{prefix}</span>}
              <input
                name="key"
                placeholder="logo"
                pattern="[a-z0-9._-]+"
                onChange={() => setKeyEdited(true)}
                required
              />
            </span>
          </label>
          <div className="wide upload-file-row">
            <label>
              File
              <input
                name="file"
                type="file"
                accept=".avif,.gif,.jpeg,.jpg,.png,.svg,.tiff,.tif,.webp,.mp4,.webm,.mov,.avi,.mpeg,.mpg"
                onChange={inferFields}
                required
              />
            </label>
            <span className="muted" role="status">
              {status}
            </span>
            <button
              className="primary-button"
              disabled={status === "Uploading…"}
            >
              Upload
            </button>
          </div>
        </div>
        {error && (
          <p className="error-strip" role="alert">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}

function AssetCard({
  asset,
  workspaceId,
  workspaceSlug,
  prefix,
}: {
  asset: AssetSummary;
  workspaceId: string;
  workspaceSlug: string;
  prefix: string;
}) {
  const [copied, setCopied] = useState(false);
  const path = assetPath(workspaceSlug, asset.key, asset.customDomain);
  const status = asset.status ?? "empty";

  async function copyUrl() {
    await navigator.clipboard.writeText(
      new URL(path, window.location.origin).href,
    );
    setCopied(true);
  }

  return (
    <li className="asset-card">
      <div className="asset-preview">
        {asset.thumbnailUrl ? (
          <img src={asset.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <span className="asset-preview-placeholder">No preview</span>
        )}
        <span className="asset-status">
          <i className={`status-dot ${status}`} /> {status}
        </span>
      </div>
      <div className="asset-info">
        <h2 title={asset.displayName}>{asset.displayName}</h2>
        <p className="asset-key">{asset.key}</p>
        <div className="asset-meta">
          <span>{asset.mimeType ? formatMimeType(asset.mimeType) : "—"}</span>
          <span>{formatDimensions(asset)}</span>
          <span>{formatBytes(asset.size ?? 0)}</span>
        </div>
        {asset.error && (
          <p className="error-strip" role="alert">
            {asset.error}
          </p>
        )}
        <div className="asset-actions">
          {asset.currentVersionId && (
            <a href={path} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          <button
            type="button"
            onClick={copyUrl}
            disabled={!asset.currentVersionId}
          >
            {copied ? "Copied" : "Copy URL"}
          </button>
          <Link
            to="/workspaces/$workspaceId/assets/$assetId"
            params={{ workspaceId, assetId: asset.id }}
            search={{ from: prefix }}
          >
            Settings
          </Link>
        </div>
      </div>
    </li>
  );
}

function VersionHistory({
  workspaceId,
  assetId,
  currentVersionId,
}: {
  workspaceId: string;
  assetId: string;
  currentVersionId: string | null;
}) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const history = useQuery({
    queryKey: ["asset-versions", workspaceId, assetId, currentVersionId],
    queryFn: () => listAssetVersions(workspaceId, assetId),
  });

  async function restore(versionId: string) {
    setPendingId(versionId);
    setError("");
    try {
      await restoreAssetVersion(workspaceId, assetId, versionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["asset", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["assets", workspaceId] }),
        queryClient.invalidateQueries({
          queryKey: ["asset-versions", workspaceId, assetId],
        }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Restore failed");
    } finally {
      setPendingId("");
    }
  }

  return (
    <section className="inspector-section">
      <h3>Version history</h3>
      {history.isPending ? (
        <p className="inspector-note">Loading versions…</p>
      ) : history.isError ? (
        <p className="error-strip" role="alert">
          {history.error.message}
        </p>
      ) : (
        <ul className="version-list">
          {history.data.versions.map((version) => (
            <li key={version.id}>
              <span>
                <strong>
                  v{version.number}
                  {version.current && <b> // CURRENT</b>}
                </strong>
                <small>
                  {formatMimeType(version.mimeType)} //{" "}
                  {formatBytes(version.size)} //{" "}
                  {new Date(version.createdAt).toLocaleString()}
                </small>
              </span>
              {/* Versions are immutable, so this only moves the pointer. */}
              <button
                type="button"
                disabled={
                  version.current ||
                  version.status !== "ready" ||
                  Boolean(pendingId)
                }
                onClick={() => void restore(version.id)}
              >
                {pendingId === version.id
                  ? "Restoring…"
                  : version.status === "ready"
                    ? "Restore"
                    : version.status}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error-strip" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function AssetDelivery({
  workspaceId,
  assetId,
}: {
  workspaceId: string;
  assetId: string;
}) {
  const delivery = useQuery({
    queryKey: ["asset-delivery", workspaceId, assetId],
    queryFn: () => getAssetDelivery(workspaceId, assetId),
  });

  return (
    <section className="inspector-section">
      <h3>Delivery // last 30 days</h3>
      {delivery.isPending ? (
        <p className="inspector-note">Loading figures…</p>
      ) : delivery.isError ? (
        <p className="error-strip" role="alert">
          {delivery.error.message}
        </p>
      ) : (
        <>
          <dl className="asset-metadata">
            <div>
              <dt>Responses</dt>
              <dd>{delivery.data.requests30d.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Transformed</dt>
              <dd>{delivery.data.transformed30d.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Bytes</dt>
              <dd>{formatBytes(delivery.data.bytes30d)}</dd>
            </div>
            <div>
              <dt>Transform cache</dt>
              <dd>
                {delivery.data.cacheHitRatio === null
                  ? "—"
                  : `${Math.round(delivery.data.cacheHitRatio * 100)}% served from cache`}
              </dd>
            </div>
          </dl>
          <p className="inspector-note">
            Successful responses, not confirmed downloads. Raw events are kept
            for 90 days.
          </p>
        </>
      )}
    </section>
  );
}

function AssetDetailPage({
  asset,
  workspaceId,
  workspaceSlug,
  fromPrefix,
}: {
  asset: AssetSummary;
  workspaceId: string;
  workspaceSlug: string;
  fromPrefix: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [previewUrl, setPreviewUrl] = useState(asset.thumbnailUrl ?? "");
  const path = assetPath(workspaceSlug, asset.key, asset.customDomain);
  const status = asset.status ?? "empty";

  async function removeAsset() {
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteAsset(workspaceId, asset.id);
      await queryClient.invalidateQueries({
        queryKey: ["assets", workspaceId],
      });
      await navigate({
        to: "/workspaces/$workspaceId/assets",
        params: { workspaceId },
        search: { prefix: fromPrefix },
      });
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Delete failed");
      setDeleting(false);
    }
  }

  return (
    <main className="dashboard-main asset-detail" id="assets">
      <header className="detail-heading">
        <div className="detail-identity">
          <Link
            className="detail-back"
            to="/workspaces/$workspaceId/assets"
            params={{ workspaceId }}
            search={{ prefix: fromPrefix }}
            aria-label="Back to assets"
          >
            ←
          </Link>
          <div>
            <p className="breadcrumb">
              {workspaceSlug} / {asset.key}
            </p>
            <h1>{asset.displayName}</h1>
          </div>
        </div>
        <div className="asset-actions">
          {asset.currentVersionId && (
            <a href={path} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          <button
            type="button"
            disabled={!asset.currentVersionId}
            onClick={async () => {
              await navigator.clipboard.writeText(
                new URL(path, window.location.origin).href,
              );
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy URL"}
          </button>
        </div>
      </header>

      <div className="asset-detail-grid">
        <section className="asset-preview-column">
          <div className="detail-preview">
            <span className="preview-label">Live preview</span>
            {previewUrl ? (
              isVideoMimeType(asset.mimeType) ? (
                <video
                  src={previewUrl}
                  controls
                  style={{ maxWidth: "100%", maxHeight: "100%" }}
                />
              ) : (
                <img src={previewUrl} alt={`Preview of ${asset.displayName}`} />
              )
            ) : (
              <span>No preview</span>
            )}
          </div>
          <dl className="asset-metadata">
            <div>
              <dt>Status</dt>
              <dd>
                <i className={`status-dot ${status}`} /> {status}
              </dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{asset.mimeType ?? "—"}</dd>
            </div>
            <div>
              <dt>Dimensions</dt>
              <dd>{formatDimensions(asset)}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(asset.size ?? 0)}</dd>
            </div>
            <div>
              <dt>Key</dt>
              <dd>{asset.key}</dd>
            </div>
          </dl>
          {asset.error && (
            <p className="error-strip" role="alert">
              {asset.error}
            </p>
          )}
        </section>
        <section className="detail-settings">
          {asset.currentVersionId && (
            <TransformationForm
              key={asset.currentVersionId}
              workspaceId={workspaceId}
              assetId={asset.id}
              sourceWidth={asset.width}
              sourceHeight={asset.height}
              sourceMimeType={asset.mimeType}
              originalUrl={path}
              onPreviewChange={setPreviewUrl}
            />
          )}
          <VersionForm workspaceId={workspaceId} assetId={asset.id} />
          <VersionHistory
            workspaceId={workspaceId}
            assetId={asset.id}
            currentVersionId={asset.currentVersionId}
          />
          <AssetDelivery workspaceId={workspaceId} assetId={asset.id} />
          <section className="danger-zone">
            <h3>Delete asset</h3>
            <p>Permanently deletes this asset and every stored version.</p>
            {deleteError && (
              <p className="error-strip" role="alert">
                {deleteError}
              </p>
            )}
            <button
              className="danger-button"
              type="button"
              disabled={deleting}
              onClick={() => setConfirmDelete(true)}
            >
              {deleting ? "Deleting…" : "Delete asset"}
            </button>
          </section>
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete asset “${asset.displayName}”?`}
        description="Every stored version and derived transformation will be permanently deleted. This cannot be undone."
        confirmLabel="Delete asset"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={removeAsset}
      />
    </main>
  );
}

type DisplayFormat =
  | NonNullable<TransformationInput["format"]>
  | "gif"
  | "svg"
  | "tiff";

function formatMimeType(mime: string) {
  return mime.split("/")[1]?.toUpperCase() ?? mime.toUpperCase();
}

function isVideoMimeType(mime: string | null): boolean {
  if (!mime) return false;
  return mime.startsWith("video/");
}

function formatForMimeType(mimeType: string | null): DisplayFormat {
  if (mimeType === "image/avif") return "avif";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/jpeg") return "jpeg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "image/tiff") return "tiff";
  return "webp";
}

function isOutputFormat(
  format: DisplayFormat,
): format is NonNullable<TransformationInput["format"]> {
  return ["avif", "jpeg", "png", "webp"].includes(format);
}

function TransformationForm({
  workspaceId,
  assetId,
  sourceWidth,
  sourceHeight,
  sourceMimeType,
  originalUrl,
  onPreviewChange,
}: {
  workspaceId: string;
  assetId: string;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceMimeType: string | null;
  originalUrl: string;
  onPreviewChange: (url: string) => void;
}) {
  const sourceFormat = formatForMimeType(sourceMimeType);
  const [format, setFormat] = useState<DisplayFormat>(sourceFormat);
  const [transformation, setTransformation] =
    useState<TransformationInput | null>(null);
  const [settledTransformation, setSettledTransformation] =
    useState<TransformationInput | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setSettledTransformation(transformation),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [transformation]);

  const preview = useQuery({
    queryKey: [
      "transformation-preview",
      workspaceId,
      assetId,
      settledTransformation,
    ],
    queryFn: () => {
      if (!settledTransformation) throw new Error("No transformation selected");
      return createTransformationUrl(
        workspaceId,
        assetId,
        settledTransformation,
      );
    },
    enabled: Boolean(settledTransformation),
    staleTime: Infinity,
  });
  const generatedUrl = transformation ? preview.data?.url : originalUrl;

  useEffect(() => {
    if (generatedUrl) onPreviewChange(generatedUrl);
  }, [generatedUrl, onPreviewChange]);

  function updatePreview(event: SyntheticEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const width = form.get("width");
    const height = form.get("height");
    const quality = form.get("quality");
    let selectedFormat = String(form.get("format")) as DisplayFormat;
    const nextWidth =
      typeof width === "string" && width ? Number(width) : undefined;
    const nextHeight =
      typeof height === "string" && height ? Number(height) : undefined;
    const nextQuality =
      typeof quality === "string" && quality ? Number(quality) : undefined;
    if (
      nextWidth === (sourceWidth ?? undefined) &&
      nextHeight === (sourceHeight ?? undefined) &&
      selectedFormat === sourceFormat &&
      (nextQuality ?? 80) === 80 &&
      form.get("fit") === "inside"
    ) {
      setTransformation(null);
      return;
    }
    if (selectedFormat === "svg") {
      selectedFormat = "png";
      setFormat("png");
    }
    const outputFormat = isOutputFormat(selectedFormat)
      ? selectedFormat
      : undefined;
    setTransformation({
      w: nextWidth,
      h: nextHeight,
      fit: String(form.get("fit")) as TransformationInput["fit"],
      format: outputFormat,
      q: outputFormat ? nextQuality : undefined,
    });
  }

  return (
    <section className="inspector-section">
      <h3>Transform URL</h3>
      <form className="compact-form" onChange={updatePreview}>
        <label>
          Width
          <input
            name="width"
            type="number"
            min="1"
            max="4096"
            defaultValue={sourceWidth ?? ""}
          />
        </label>
        <label>
          Height
          <input
            name="height"
            type="number"
            min="1"
            max="4096"
            defaultValue={sourceHeight ?? ""}
          />
        </label>
        <label>
          Fit
          <select name="fit" defaultValue="inside">
            <option value="inside">Inside</option>
            <option value="cover">Cover</option>
            <option value="contain">Contain</option>
            <option value="fill">Fill</option>
            <option value="outside">Outside</option>
          </select>
        </label>
        <label>
          Format
          <select
            name="format"
            value={format}
            onChange={(event) => setFormat(event.target.value as DisplayFormat)}
          >
            {sourceFormat === "svg" && <option value="svg">SVG</option>}
            {sourceFormat === "gif" && <option value="gif">GIF</option>}
            {sourceFormat === "tiff" && <option value="tiff">TIFF</option>}
            <option value="webp">WebP</option>
            <option value="avif">AVIF</option>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
          </select>
        </label>
        <label>
          Quality
          <input
            name="quality"
            type="number"
            min="1"
            max="100"
            defaultValue="80"
            disabled={!isOutputFormat(format)}
          />
        </label>
      </form>
      {preview.isError && (
        <p className="error-strip" role="alert">
          {preview.error.message}
        </p>
      )}
      {generatedUrl && (
        <div className="generated-url">
          <a href={generatedUrl} target="_blank" rel="noreferrer">
            {generatedUrl}
          </a>
        </div>
      )}
    </section>
  );
}

function VersionForm({
  workspaceId,
  assetId,
}: {
  workspaceId: string;
  assetId: string;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Uploading…");
    const formElement = event.currentTarget;
    const file = new FormData(formElement).get("file");
    try {
      if (!(file instanceof File) || !file.size)
        throw new Error("Choose a file");
      await uploadVersion(workspaceId, assetId, file);
      formElement.reset();
      setStatus("Processing…");
      await queryClient.invalidateQueries({
        queryKey: ["assets", workspaceId],
      });
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Upload failed");
    }
  }

  return (
    <section className="inspector-section">
      <h3>New version</h3>
      <form className="compact-form version-upload-form" onSubmit={submit}>
        <label>
          File
          <input
            name="file"
            type="file"
            accept="image/avif,image/gif,image/jpeg,image/png,image/svg+xml,image/tiff,image/webp"
            required
          />
        </label>
        <button disabled={status === "Uploading…"}>Upload</button>
        <span className="muted" role="status">
          {status}
        </span>
      </form>
    </section>
  );
}

function assetPath(
  workspaceSlug: string,
  key: string,
  customDomain?: string | null,
) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return customDomain
    ? `https://${customDomain}/w/${encodedKey}`
    : `/w/${encodeURIComponent(workspaceSlug)}/${encodedKey}`;
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDimensions(asset: AssetSummary) {
  return asset.width && asset.height ? `${asset.width}×${asset.height}` : "—";
}
