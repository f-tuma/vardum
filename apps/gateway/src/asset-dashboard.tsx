import { CopyButton, useDebouncedValue } from "./ui-controls";
import { isVideoMimeType, uploadAccept } from "@vardum/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  assetDeliveryPath,
  createAsset,
  createFolder,
  createTransformationUrl,
  deleteAsset,
  deleteFolder,
  getAsset,
  formatUploadLimit,
  getAssetDelivery,
  getUploadLimits,
  importAssets,
  listAssets,
  listAssetVersions,
  restoreAssetVersion,
  retryAssetVersion,
  setAssetVisibility,
  uploadVersion,
  validateUploadFile,
  type AssetSummary,
  type TransformationInput,
} from "./asset-api";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTip } from "./info-tip";
import { FormDialog } from "./form-dialog";
import { FolderIcon } from "./folder-icon";

export function AssetDashboard({
  canPublish,
  workspaceId,
  workspaceSlug,
  workspaceName,
  search,
  onClearSearch,
  assetId,
  prefix,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  canPublish: boolean;
  search: string;
  onClearSearch: () => void;
  assetId?: string;
  prefix: string;
}) {
  const navigate = useNavigate();
  const needle = useDebouncedValue(search.trim());
  const [uploadQueue, setUploadQueue] = useState<
    Array<{
      id: string;
      filename: string;
      status: string;
      progress?: number;
    }>
  >([]);

  function addUpload(id: string, filename: string) {
    setUploadQueue((prev) => [...prev, { id, filename, status: "Starting…" }]);
  }
  function updateUpload(id: string, status: string, progress?: number) {
    setUploadQueue((prev) =>
      prev.map((u) => (u.id === id ? { ...u, status, progress } : u)),
    );
  }
  function removeUpload(id: string) {
    setUploadQueue((prev) => prev.filter((u) => u.id !== id));
  }
  const assets = useQuery({
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
    refetchInterval: (query) =>
      query.state.data?.status === "processing" ? 1500 : false,
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
        key={`${detail.data.id}:${detail.data.isPublic}`}
        canPublish={canPublish}
        asset={detail.data}
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        fromPrefix={prefix}
        fromSearch={search}
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
            {assets.isFetching
              ? "Loading…"
              : needle
                ? `${filteredAssets.length} matches across all folders`
                : `${filteredFolders.length + filteredAssets.length} items`}
          </p>
        </div>
        {canPublish && (
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
        )}
      </header>
      {needle && (
        <div className="search-results-bar">
          <span>Results for “{needle}”</span>
          <button type="button" onClick={onClearSearch}>
            Clear search
          </button>
        </div>
      )}

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
                    canPublish={canPublish}
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
                    search={search}
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
            {search
              ? "Try another name or key."
              : canPublish
                ? "Choose Upload asset to add your first file."
                : "Files uploaded by your team will appear here."}
          </p>
        </div>
      )}
      {uploadQueue.length > 0 && (
        <div className="upload-queue">
          {uploadQueue.map((entry) => (
            <span key={entry.id} className="upload-queue-item">
              <span className="upload-queue-name">{entry.filename}</span>
              <small>
                {entry.progress === undefined
                  ? entry.status
                  : asciiBar(entry.progress)}
              </small>
            </span>
          ))}
        </div>
      )}
    </main>
  );
}

function FolderCard({
  folder,
  canPublish,
  workspaceId,
  onOpen,
}: {
  folder: { name: string; prefix: string };
  canPublish: boolean;
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
        <FolderIcon /> {folder.name}
      </button>
      {canPublish && (
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
      )}
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
      if (
        event.target instanceof Element &&
        event.target.closest(".info-tip-position")
      )
        return;
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
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [pending, setPending] = useState(false);

  // The endpoint walks one page per call, so the loop lives here and the user
  // watches the count climb instead of waiting on one long request.
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
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
    <>
      <button
        type="button"
        onClick={() => {
          setError("");
          setProgress("");
          setOpen(true);
        }}
      >
        Import from S3
      </button>
      <FormDialog
        open={open}
        title="Import from S3"
        pending={pending}
        onClose={() => setOpen(false)}
      >
        <form className="creation-form" onSubmit={submit}>
          <label>
            Bucket prefix
            <input
              name="source"
              autoFocus
              placeholder="legacy-photos/"
              maxLength={1024}
              required
            />
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
      </FormDialog>
    </>
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
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
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
      setOpen(false);
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
    <>
      <button
        type="button"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        New folder
      </button>
      <FormDialog
        open={open}
        title="New folder"
        pending={pending}
        onClose={() => setOpen(false)}
      >
        <form className="creation-form" onSubmit={submit}>
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
      </FormDialog>
    </>
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
  onUpdateUpload: (id: string, status: string, progress?: number) => void;
  onRemoveUpload: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [keyEdited, setKeyEdited] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setStatus("Uploading…");
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");
    const uploadId = crypto.randomUUID();

    try {
      if (!(file instanceof File) || !file.size)
        throw new Error("Choose a file");
      await validateUploadFile(file);
      const onProgress = (s: string, progress?: number) => {
        setStatus(s);
        onUpdateUpload(uploadId, s, progress);
      };
      onAddUpload(uploadId, file.name);
      const created = await createAsset(workspaceId, {
        key: `${prefix}${String(form.get("key"))}`,
        displayName: String(form.get("displayName")),
      });
      await uploadVersion(workspaceId, created.id, file, onProgress);
      formElement.reset();
      setKeyEdited(false);
      setOpen(false);
      setStatus("Done");
      onUpdateUpload(uploadId, "Done");
      setTimeout(() => onRemoveUpload(uploadId), 5000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
      setStatus("");
      // Without this the entry sits in the queue forever, still saying "Uploading…".
      onUpdateUpload(uploadId, "Failed");
      setTimeout(() => onRemoveUpload(uploadId), 5000);
    } finally {
      setPending(false);
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
    <>
      <button
        className="primary-button"
        type="button"
        onClick={() => {
          setError("");
          setStatus("");
          setKeyEdited(false);
          setOpen(true);
        }}
      >
        Upload asset
      </button>
      <FormDialog
        open={open}
        title="Upload asset"
        pending={pending}
        onClose={() => setOpen(false)}
      >
        <form className="creation-form" onSubmit={submit}>
          <div className="form-grid">
            <label>
              Display name
              <input
                name="displayName"
                autoFocus
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
                <span className="heading-with-tip">
                  File <UploadLimitHint />
                </span>
                <input
                  name="file"
                  type="file"
                  accept={uploadAccept}
                  onChange={inferFields}
                  required
                />
              </label>
              <span className="muted" role="status">
                {status}
              </span>
              <button className="primary-button" disabled={pending}>
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
      </FormDialog>
    </>
  );
}

function AssetCard({
  asset,
  workspaceId,
  workspaceSlug,
  prefix,
  search,
}: {
  asset: AssetSummary;
  workspaceId: string;
  workspaceSlug: string;
  prefix: string;
  search: string;
}) {
  const path = assetDeliveryPath(workspaceSlug, asset);
  const status = asset.status ?? "empty";

  return (
    <li className="asset-card">
      <Link
        className="asset-preview"
        to="/workspaces/$workspaceId/assets/$assetId"
        params={{ workspaceId, assetId: asset.id }}
        search={{ from: prefix, ...(search ? { q: search } : {}) }}
        aria-label={`View ${asset.displayName}`}
      >
        {asset.thumbnailUrl ? (
          isVideoMimeType(asset.mimeType) ? (
            <video
              src={asset.thumbnailUrl}
              muted
              playsInline
              preload="metadata"
            />
          ) : (
            <img src={asset.thumbnailUrl} alt="" loading="lazy" />
          )
        ) : (
          <span className="asset-preview-placeholder">No preview</span>
        )}
        <span className="asset-status">
          <i className={`status-dot ${status}`} /> {status}
        </span>
      </Link>
      <div className="asset-info">
        <h2 title={asset.displayName}>{asset.displayName}</h2>
        <p className="asset-key">
          {asset.key} · {asset.isPublic ? "Public" : "Private"}
        </p>
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
          <CopyButton
            text={new URL(path, window.location.origin).href}
            label="Copy URL"
            disabled={!asset.currentVersionId}
          />
          <Link
            to="/workspaces/$workspaceId/assets/$assetId"
            params={{ workspaceId, assetId: asset.id }}
            search={{ from: prefix, ...(search ? { q: search } : {}) }}
          >
            Details
          </Link>
        </div>
      </div>
    </li>
  );
}

function VersionHistory({
  canPublish,
  workspaceId,
  assetId,
  currentVersionId,
}: {
  workspaceId: string;
  assetId: string;
  currentVersionId: string | null;
  canPublish: boolean;
}) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const history = useQuery({
    queryKey: ["asset-versions", workspaceId, assetId, currentVersionId],
    queryFn: () => listAssetVersions(workspaceId, assetId),
    refetchInterval: (query) =>
      query.state.data?.versions.some(
        (version) => version.status === "processing",
      )
        ? 1500
        : false,
  });

  async function updateVersion(versionId: string, retry = false) {
    setPendingId(versionId);
    setError("");
    try {
      await (retry ? retryAssetVersion : restoreAssetVersion)(
        workspaceId,
        assetId,
        versionId,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["asset", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["assets", workspaceId] }),
        queryClient.invalidateQueries({
          queryKey: ["asset-versions", workspaceId, assetId],
        }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Version update failed",
      );
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
              <button
                type="button"
                disabled={
                  !canPublish ||
                  version.current ||
                  !(
                    version.status === "ready" ||
                    (version.status === "failed" && version.retryable)
                  ) ||
                  Boolean(pendingId)
                }
                onClick={() =>
                  void updateVersion(version.id, version.status === "failed")
                }
              >
                {pendingId === version.id
                  ? "Working…"
                  : version.status === "ready"
                    ? "Restore"
                    : version.status === "failed" && version.retryable
                      ? "Retry processing"
                      : version.status}
              </button>
              {version.error && (
                <small className="version-error">{version.error}</small>
              )}
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
      <h3 className="heading-with-tip">
        Delivery // last 30 days
        <InfoTip label="About delivery statistics">
          Successful responses, not confirmed downloads. Raw events are kept for
          90 days.
        </InfoTip>
      </h3>
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
        </>
      )}
    </section>
  );
}

function AssetDetailPage({
  canPublish,
  asset,
  workspaceId,
  workspaceSlug,
  fromPrefix,
  fromSearch,
}: {
  asset: AssetSummary;
  workspaceId: string;
  workspaceSlug: string;
  fromPrefix: string;
  fromSearch: string;
  canPublish: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [visibilityPending, setVisibilityPending] = useState(false);
  const [visibilityError, setVisibilityError] = useState("");
  const [confirmVisibility, setConfirmVisibility] = useState(false);

  async function changeVisibility() {
    setVisibilityPending(true);
    setVisibilityError("");
    try {
      await setAssetVisibility(workspaceId, asset.id, !asset.isPublic);
      const previews = {
        queryKey: ["transformation-preview", workspaceId, asset.id],
      };
      await queryClient.cancelQueries(previews);
      queryClient.removeQueries(previews);
      await Promise.all(
        ["asset", "assets", "vard", "vards", "audit", "workspace-overview"].map(
          (key) =>
            queryClient.invalidateQueries({ queryKey: [key, workspaceId] }),
        ),
      );
    } catch (cause) {
      setVisibilityError(
        cause instanceof Error ? cause.message : "Visibility change failed",
      );
    } finally {
      setVisibilityPending(false);
      setConfirmVisibility(false);
    }
  }
  const [previewUrl, setPreviewUrl] = useState(asset.thumbnailUrl ?? "");
  const path = assetDeliveryPath(workspaceSlug, asset);
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
            search={{
              prefix: fromPrefix,
              ...(fromSearch ? { q: fromSearch } : {}),
            }}
            aria-label="Back to assets"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M16.5 10h-13M9.5 4l-6 6 6 6" />
            </svg>
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
          <CopyButton
            text={new URL(path, window.location.origin).href}
            label="Copy URL"
            disabled={!asset.currentVersionId}
          />
        </div>
      </header>

      <div className="asset-detail-grid">
        <section className="asset-preview-column">
          <div className="detail-preview">
            <span className="preview-label">Live preview</span>
            {previewUrl ? (
              isVideoMimeType(asset.mimeType) ? (
                <video src={previewUrl} controls />
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
          <section className="inspector-section asset-visibility">
            <header className="asset-visibility-heading">
              <h3 className="heading-with-tip">
                Visibility
                <InfoTip label="About asset visibility">
                  Private files require workspace read access, including signed
                  variants. New assets are private. Making a public file private
                  cannot revoke downloaded, offline, or shared cached copies.
                </InfoTip>
              </h3>
              <span className="asset-visibility-status">
                {asset.isPublic ? "Public" : "Private"}
              </span>
            </header>
            {canPublish && (
              <button
                type="button"
                disabled={visibilityPending}
                onClick={() => setConfirmVisibility(true)}
              >
                Make {asset.isPublic ? "private" : "public"}
              </button>
            )}
            {visibilityError && (
              <p className="error-strip" role="alert">
                {visibilityError}
              </p>
            )}
          </section>
          {asset.currentVersionId && !isVideoMimeType(asset.mimeType) && (
            <TransformationForm
              key={`${asset.currentVersionId}:${asset.isPublic}`}
              workspaceId={workspaceId}
              assetId={asset.id}
              sourceWidth={asset.width}
              sourceHeight={asset.height}
              sourceMimeType={asset.mimeType}
              originalUrl={path}
              onPreviewChange={setPreviewUrl}
            />
          )}
          {canPublish && (
            <VersionForm workspaceId={workspaceId} assetId={asset.id} />
          )}
          <VersionHistory
            canPublish={canPublish}
            workspaceId={workspaceId}
            assetId={asset.id}
            currentVersionId={asset.currentVersionId}
          />
          <AssetDelivery workspaceId={workspaceId} assetId={asset.id} />
          <section className="danger-zone">
            <h3 className="heading-with-tip">
              Delete asset
              <InfoTip label="About deleting an asset">
                Permanently deletes this asset and every stored version.
              </InfoTip>
            </h3>
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
        open={confirmVisibility}
        title={`Make asset ${asset.isPublic ? "private" : "public"}?`}
        tone="neutral"
        description={
          asset.isPublic
            ? "New requests will require workspace read access. Previously downloaded, offline, and cached copies cannot be revoked. Public Vards containing this asset will no longer be available anonymously."
            : "Anyone with a delivery link will be able to read every ready version and its variants."
        }
        confirmLabel={asset.isPublic ? "Make private" : "Make public"}
        onCancel={() => setConfirmVisibility(false)}
        onConfirm={changeVisibility}
      />
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
  NonNullable<TransformationInput["format"]> | "gif" | "svg" | "tiff";

/** Upload progress in the same box-drawing style as the rest of the shell. */
function asciiBar(fraction: number, width = 12) {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function formatMimeType(mime: string) {
  return mime.split("/")[1]?.toUpperCase() ?? mime.toUpperCase();
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
      originalUrl,
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
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("Uploading…");
    setPending(true);
    const formElement = event.currentTarget;
    const file = new FormData(formElement).get("file");
    try {
      if (!(file instanceof File) || !file.size)
        throw new Error("Choose a file");
      await uploadVersion(workspaceId, assetId, file, (label, progress) =>
        setStatus(progress === undefined ? label : asciiBar(progress)),
      );
      formElement.reset();
      setStatus("Processing…");
      await queryClient.invalidateQueries({
        queryKey: ["assets", workspaceId],
      });
    } catch (cause) {
      setStatus("");
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="inspector-section">
      <h3 className="heading-with-tip">
        New version <UploadLimitHint />
      </h3>
      <form className="compact-form version-upload-form" onSubmit={submit}>
        <label>
          File
          <input
            name="file"
            type="file"
            accept={uploadAccept}
            required
            onChange={() => {
              setError("");
              setStatus("");
            }}
          />
        </label>
        <button disabled={pending}>Upload</button>
        {error && (
          <p className="error-strip full" role="alert">
            {error}
          </p>
        )}
        <span className="muted" role="status">
          {status}
        </span>
      </form>
    </section>
  );
}

function UploadLimitHint() {
  const limits = useQuery({
    queryKey: ["upload-limits"],
    queryFn: getUploadLimits,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!limits.data) return null;
  return (
    <InfoTip label="Upload size limits">
      {`Images up to ${formatUploadLimit(limits.data.image)}, videos up to ${formatUploadLimit(limits.data.video)}. Larger files will be rejected before upload.`}
    </InfoTip>
  );
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
