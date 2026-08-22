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
  listAssets,
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
  const assets = useQuery({
    queryKey: ["assets", workspaceId, prefix],
    queryFn: () => listAssets(workspaceId, prefix),
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
  const allAssets = assets.data?.assets ?? [];
  const folders = assets.data?.folders ?? [];
  const needle = search.trim().toLowerCase();
  const filteredAssets = allAssets.filter(({ displayName, key }) =>
    `${displayName} ${key}`.toLowerCase().includes(needle),
  );
  const filteredFolders = folders.filter(({ name }) =>
    name.toLowerCase().includes(needle),
  );

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
          <p>{filteredFolders.length + filteredAssets.length} items</p>
        </div>
        <div className="page-actions">
          <NewFolderForm workspaceId={workspaceId} prefix={prefix} />
          <NewAssetForm workspaceId={workspaceId} prefix={prefix} />
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

function FolderBreadcrumbs({
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

function useCloseDetailsOnOutsideClick() {
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
    <details ref={detailsRef} className="upload-drawer folder-drawer">
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
}: {
  workspaceId: string;
  prefix: string;
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
      const created = await createAsset(workspaceId, {
        key: `${prefix}${String(form.get("key"))}`,
        displayName: String(form.get("displayName")),
      });
      await uploadVersion(workspaceId, created.id, file);
      formElement.reset();
      setKeyEdited(false);
      setStatus("Processing…");
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
                accept="image/avif,image/gif,image/jpeg,image/png,image/tiff,image/webp"
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
  const path = assetPath(workspaceSlug, asset.key);
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
          <span>
            {asset.mimeType?.replace("image/", "").toUpperCase() ?? "—"}
          </span>
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
  const path = assetPath(workspaceSlug, asset.key);
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
              <img src={previewUrl} alt={`Preview of ${asset.displayName}`} />
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
              workspaceId={workspaceId}
              assetId={asset.id}
              onPreviewChange={setPreviewUrl}
            />
          )}
          <VersionForm workspaceId={workspaceId} assetId={asset.id} />
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

function TransformationForm({
  workspaceId,
  assetId,
  onPreviewChange,
}: {
  workspaceId: string;
  assetId: string;
  onPreviewChange: (url: string) => void;
}) {
  const initialTransformation: TransformationInput = {
    w: 640,
    fit: "inside",
    format: "webp",
    q: 80,
  };
  const [transformation, setTransformation] = useState(initialTransformation);
  const [settledTransformation, setSettledTransformation] = useState(
    initialTransformation,
  );

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
    queryFn: () =>
      createTransformationUrl(workspaceId, assetId, settledTransformation),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (preview.data?.url) onPreviewChange(preview.data.url);
  }, [onPreviewChange, preview.data?.url]);

  function updatePreview(event: SyntheticEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const width = String(form.get("width"));
    const height = String(form.get("height"));
    const quality = String(form.get("quality"));
    setTransformation({
      w: width ? Number(width) : undefined,
      h: height ? Number(height) : undefined,
      fit: String(form.get("fit")) as TransformationInput["fit"],
      format: String(form.get("format")) as TransformationInput["format"],
      q: quality ? Number(quality) : undefined,
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
            defaultValue="640"
          />
        </label>
        <label>
          Height
          <input name="height" type="number" min="1" max="4096" />
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
          <select name="format" defaultValue="webp">
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
          />
        </label>
      </form>
      {preview.isError && (
        <p className="error-strip" role="alert">
          {preview.error.message}
        </p>
      )}
      {preview.data?.url && (
        <div className="generated-url">
          <a href={preview.data.url} target="_blank" rel="noreferrer">
            {preview.data.url}
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
      <form className="compact-form" onSubmit={submit}>
        <label className="full">
          File
          <input
            name="file"
            type="file"
            accept="image/avif,image/gif,image/jpeg,image/png,image/tiff,image/webp"
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

function assetPath(workspaceSlug: string, key: string) {
  return `/w/${encodeURIComponent(workspaceSlug)}/${key.split("/").map(encodeURIComponent).join("/")}`;
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
