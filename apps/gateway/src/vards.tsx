import { CopyButton, FilterInput, PageTabs, TabPanel } from "./ui-controls";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { VardDefinition, VardFolderRule } from "@vardum/shared";
import {
  createVard,
  deleteVard,
  getVard,
  getVardManifest,
  listAssets,
  listSyncAssets,
  listVards,
  replaceVardItems,
  updateVard,
  type AssetSummary,
  type TransformationInput,
  type SyncAsset,
  type VardItem,
} from "./asset-api";
import { FolderBreadcrumbs } from "./asset-dashboard";
import { ConfirmDialog } from "./confirm-dialog";
import { Modal } from "./modal";
import { FormDialog } from "./form-dialog";
import { FolderIcon } from "./folder-icon";
import { InfoTip } from "./info-tip";
import { cliSetupCommand, CLI_SETUP_VERSION } from "./cli-setup";
import { VardFilePreview } from "./vard-file-preview";
import { sourcePreview } from "./vard-preview-url";
import {
  applyVardMetadata,
  generatedOutputs,
  manualDraftItems,
  refreshVardPreview,
  type DraftItem,
} from "./vard-editor-state";

const editorTabs = [
  ["files", "Files"],
  ["folders", "Folder rules"],
  ["preview", "Preview"],
  ["config", "CLI config"],
  ["settings", "Settings"],
] as const;

function PublicManifestTip() {
  return (
    <InfoTip label="About public manifests">
      This does not publish files or grant asset access. Any private mapped
      asset, including a new folder member, blocks the entire anonymous
      manifest; workspace readers can still use it.
    </InfoTip>
  );
}

export function VardsPage({
  workspaceId,
  workspaceName,
  canEdit,
}: {
  workspaceId: string;
  workspaceName: string;
  canEdit: boolean;
}) {
  const [search, setSearch] = useState("");
  const vards = useQuery({
    queryKey: ["vards", workspaceId],
    queryFn: () => listVards(workspaceId),
  });

  const matchingVards = (vards.data?.vards ?? []).filter((vard) =>
    vard.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

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
          <div className="list-toolbar">
            <FilterInput
              value={search}
              onChange={setSearch}
              label="Find Vards"
            />
          </div>
          {vards.isPending ? (
            <p className="settings-state">Loading Vards…</p>
          ) : vards.isError ? (
            <p className="error-strip settings-inline-error" role="alert">
              {vards.error.message}
            </p>
          ) : matchingVards.length ? (
            <ul className="vard-list">
              {matchingVards.map((vard) => (
                <li key={vard.id}>
                  <span>
                    <strong>{vard.name}</strong>
                    <small>
                      {vard.isPublic ? "PUBLIC" : "PRIVATE"} // {vard.itemCount}{" "}
                      MANUAL ITEMS
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
            <p className="settings-state">
              {search
                ? "No matching Vards."
                : canEdit
                  ? "└─ Create a Vard to choose which files go into your project."
                  : "└─ No Vards yet"}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function NewVardForm({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
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
      const form = new FormData(formElement);
      const vard = await createVard(workspaceId, {
        name: String(form.get("name")),
        isPublic: form.get("isPublic") === "on",
      });
      formElement.reset();
      setOpen(false);
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
    <>
      <button
        className="primary-button"
        type="button"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        New Vard
      </button>
      <FormDialog
        open={open}
        title="New Vard"
        pending={pending}
        onClose={() => setOpen(false)}
      >
        <form className="creation-form" onSubmit={submit}>
          <label>
            Vard name
            <input
              name="name"
              placeholder="Website"
              maxLength={80}
              autoFocus
              required
            />
          </label>
          <div className="heading-with-tip">
            <label className="checkbox-label">
              <input type="checkbox" name="isPublic" />
              Public manifest
            </label>
            <PublicManifestTip />
          </div>
          {error && (
            <p className="error-strip" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" disabled={pending}>
            {pending ? "Creating…" : "Create Vard"}
          </button>
        </form>
      </FormDialog>
    </>
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
  const preview = useQuery({
    queryKey: ["vard-preview", workspaceId, vardId],
    queryFn: () => getVardManifest(workspaceId, vardId),
    enabled: Boolean(vard.data),
    retry: false,
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
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!vard.data) return;
    setName(vard.data.name);
    setIsPublic(vard.data.isPublic);
    setItems(manualDraftItems(vard.data));
  }, [vard.data]);

  function beginSave() {
    if (!canEdit || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    return true;
  }

  async function refreshAfterSave() {
    // A refresh failure is not a failed write. Never roll back accepted data.
    try {
      await Promise.all([
        queryClient.invalidateQueries(
          { queryKey: ["vards", workspaceId] },
          { throwOnError: true },
        ),
        refreshVardPreview(queryClient, workspaceId, vardId),
      ]);
    } catch {
      setMessage("Saved. The Vard list could not refresh; reload to retry.");
    }
  }

  async function persistItems(next: DraftItem[]) {
    if (!beginSave()) return;
    try {
      await queryClient.cancelQueries({
        queryKey: ["vard", workspaceId, vardId],
      });
      const saved = await replaceVardItems(
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
      queryClient.setQueryData(["vard", workspaceId, vardId], saved);
      setItems(manualDraftItems(saved));
      setMessage("Saved");
      await refreshAfterSave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vard update failed");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function persistManifest(patch: {
    name?: string;
    isPublic?: boolean;
    folderRules?: VardFolderRule[];
  }) {
    if (!beginSave()) return false;
    try {
      await queryClient.cancelQueries({
        queryKey: ["vard", workspaceId, vardId],
      });
      const saved = await updateVard(workspaceId, vardId, patch);
      queryClient.setQueryData<VardDefinition>(
        ["vard", workspaceId, vardId],
        (current) => (current ? applyVardMetadata(current, saved) : current),
      );
      setName(saved.name);
      setIsPublic(saved.isPublic);
      setMessage("Saved");
      await refreshAfterSave();
      return true;
    } catch (cause) {
      const current = queryClient.getQueryData<VardDefinition>([
        "vard",
        workspaceId,
        vardId,
      ]);
      if (current) {
        setName(current.name);
        setIsPublic(current.isPublic);
      }
      setError(cause instanceof Error ? cause.message : "Vard update failed");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
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

  if (vard.isPending) return <div className="loading">Loading Vard…</div>;
  if (vard.isError)
    return (
      <div className="state-panel" role="alert">
        {vard.error.message}
      </div>
    );

  const { folders, files } = outputTree(items, outputPrefix);
  const savedItems = new Map(vard.data.items.map((item) => [item.id, item]));
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
        <Link
          className="back-link"
          to="/workspaces/$workspaceId/vards"
          params={{ workspaceId }}
        >
          ← Vards
        </Link>
        <h1>{vard.data.name}</h1>
        <span>Project files and folder mappings.</span>
      </header>

      <PageTabs label="Vard editor" items={editorTabs}>
        {error && (
          <p className="error-strip" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="settings-state" role="status">
            {message}
          </p>
        )}
        <TabPanel id="settings">
          <section className="settings-panel" id="vard-manifest">
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
                  disabled={!canEdit || saving}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => {
                    if (name && name !== vard.data.name)
                      void persistManifest({ name });
                  }}
                />
              </label>
              <div className="heading-with-tip">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={isPublic}
                    disabled={!canEdit || saving}
                    onChange={(event) => {
                      void persistManifest({ isPublic: event.target.checked });
                    }}
                  />
                  Public manifest
                </label>
                <PublicManifestTip />
              </div>
              <div className="settings-url">
                <span>VARD ID</span>
                <code>{vardId}</code>
              </div>
            </form>
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
                  disabled={saving}
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete Vard
                </button>
              </div>
            </section>
          )}
        </TabPanel>

        <TabPanel id="config" guide="vard-config">
          <section className="settings-panel" id="vard-setup">
            <header>
              <h2 className="heading-with-tip">
                ┌─ TERMINAL SETUP
                <InfoTip label="About terminal setup">
                  Run in your project root using bash or zsh with Node.js 22 or
                  newer. Installs the CLI, creates vardum.json, opens browser
                  authorization for this workspace, then pulls your files. Each
                  step runs only if the previous one succeeds.
                </InfoTip>
              </h2>
              <CopyButton
                label="Copy setup"
                text={cliSetupCommand(
                  window.location.origin,
                  workspaceId,
                  vardId,
                )}
              />
            </header>
            <pre className="vard-config vard-setup-command">
              <code>
                {cliSetupCommand(window.location.origin, workspaceId, vardId)}
              </code>
            </pre>
            <p className="settings-state">
              CLI {CLI_SETUP_VERSION} · Node.js 22+
            </p>
          </section>
          <section className="settings-panel" id="vard-config">
            <header>
              <h2 className="heading-with-tip">
                ┌─ VARDUM.JSON
                <InfoTip label="About CLI configuration">
                  Run vardum init with these values, or save this configuration
                  as vardum.json in your project. Private files and manifests
                  need workspace read access. Use vardum login locally or
                  VARDUM_API_KEY in CI.
                </InfoTip>
              </h2>
              <CopyButton text={config} />
            </header>
            <pre className="vard-config">
              <code>{config}</code>
            </pre>
          </section>
        </TabPanel>

        <TabPanel id="folders" guide="vard-folders">
          <FolderRulesForm
            key={vardId}
            rules={vard.data.folderRules}
            canEdit={canEdit}
            saving={saving}
            onSave={(folderRules) => persistManifest({ folderRules })}
          />
        </TabPanel>

        <TabPanel id="preview">
          <section className="settings-panel" id="vard-preview">
            <header>
              <h2 className="heading-with-tip">
                ┌─ RESOLVED OUTPUTS
                <InfoTip label="About resolved outputs">
                  Preview of saved configuration, excluding unsaved rules.
                  Folder outputs use the latest ready originals and are
                  read-only. Run vardum pull to adopt changes; --frozen uses
                  your committed snapshot. There is no background sync.
                </InfoTip>
              </h2>
              <button
                type="button"
                disabled={saving || preview.isFetching}
                onClick={() => void preview.refetch()}
              >
                Refresh preview
              </button>
            </header>
            {preview.isFetching ? (
              <p className="settings-state" role="status">
                Resolving outputs…
              </p>
            ) : preview.isError ? (
              <p className="error-strip settings-inline-error" role="alert">
                Preview unavailable: {preview.error.message}. Edit manual paths
                or folder rules to repair collisions or reduce outputs, then
                refresh. Configuration remains editable.
              </p>
            ) : preview.data ? (
              <>
                <div className="vard-preview-summary">
                  <span>{preview.data.items.length} outputs</span>
                  <span>{vard.data.items.length} manual</span>
                  <span>
                    {generatedOutputs(preview.data).length} from folders
                  </span>
                </div>
                <ul className="vard-list">
                  {generatedOutputs(preview.data).map((item) => (
                    <li key={item.id}>
                      <span>
                        <strong>{item.outputPath}</strong>
                        <small>{item.key} → original // READ-ONLY</small>
                      </span>
                    </li>
                  ))}
                </ul>
                {!generatedOutputs(preview.data).length && (
                  <p className="settings-state">└─ No folder outputs</p>
                )}
              </>
            ) : null}
          </section>
        </TabPanel>

        <TabPanel id="files" guide="vard-files">
          <section className="settings-panel" id="vard-outputs">
            <header className="outputs-header">
              <h2>┌─ MANUAL OUTPUTS</h2>
              <span role="status">
                /{outputPrefix} // {items.length} FILES
              </span>
              {canEdit && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setPickerOpen(true)}
                >
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
                    <FolderIcon /> ..
                  </button>
                )}
                {folders.map((folder) => (
                  <button
                    key={folder.prefix}
                    className="folder-open"
                    type="button"
                    onClick={() => setOutputPrefix(folder.prefix)}
                  >
                    <FolderIcon /> {folder.name}
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
                    <VardFilePreview
                      url={savedItems.get(item.id)?.downloadUrl}
                      mimeType={savedItems.get(item.id)?.mimeType}
                    />
                    <span className="vard-file-caption">
                      <span>{item.outputPath.slice(outputPrefix.length)}</span>
                      <small>{itemBadge(item)}</small>
                    </span>
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

            {assets.isError && (
              <p className="error-strip settings-inline-error" role="alert">
                Asset details unavailable: {assets.error.message}. Manual
                mappings and folder rules remain editable.
              </p>
            )}
          </section>
        </TabPanel>
      </PageTabs>

      {editing && (
        <VardItemDialog
          key={editing.id}
          item={editing}
          isNew={Boolean(newItem)}
          source={assets.data?.assets.find(({ id }) => id === editing.assetId)}
          workspaceSlug={assets.data?.workspaceSlug}
          saved={savedItems.get(editing.id)}
          canEdit={canEdit && !saving}
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

function FolderRulesForm({
  rules,
  canEdit,
  saving,
  onSave,
}: {
  rules: VardFolderRule[];
  canEdit: boolean;
  saving: boolean;
  onSave: (rules: VardFolderRule[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(rules);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(rules);
  }, [rules, dirty]);

  function change(next: VardFolderRule[]) {
    setDraft(next);
    setDirty(true);
  }

  function changeRule(index: number, patch: Partial<VardFolderRule>) {
    change(
      draft.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );
  }

  return (
    <section className="settings-panel" id="vard-folders">
      <header>
        <h2 className="heading-with-tip">
          ┌─ FOLDER RULES
          <InfoTip label="About folder rules">
            Recursively map a source folder to a project folder, for example
            brand/ → assets/brand/. Empty prefixes mean root; other prefixes
            must end with /. Only ready current originals are included. No
            globs, transformations, pinned versions or writable outputs. Up to
            64 rules, 255 characters per prefix and 1,000 total outputs.
            Overlapping output paths are rejected.
          </InfoTip>
        </h2>
        <span role="status">{dirty ? "UNSAVED RULES" : "SAVED RULES"}</span>
      </header>
      <form
        className="folder-rules-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (canEdit && dirty && !saving && (await onSave(draft)))
            setDirty(false);
        }}
      >
        {draft.map((rule, index) => (
          <div className="drawer-row" key={index}>
            <label>
              Source prefix {index + 1}
              <input
                value={rule.sourcePrefix}
                maxLength={255}
                placeholder="brand/ (empty = root)"
                disabled={!canEdit || saving}
                onChange={(event) =>
                  changeRule(index, { sourcePrefix: event.target.value })
                }
              />
            </label>
            <label>
              Output prefix {index + 1}
              <input
                value={rule.outputPrefix}
                maxLength={255}
                placeholder="assets/brand/ (empty = root)"
                disabled={!canEdit || saving}
                onChange={(event) =>
                  changeRule(index, { outputPrefix: event.target.value })
                }
              />
            </label>
            {canEdit && (
              <button
                type="button"
                disabled={saving}
                aria-label={`Remove folder rule ${index + 1}`}
                onClick={() => change(draft.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {!draft.length && <p className="settings-state">└─ No folder rules</p>}
        {canEdit && (
          <div className="folder-rule-actions">
            <div className="heading-with-tip">
              <button
                type="button"
                disabled={saving || draft.length >= 64}
                onClick={() =>
                  change([...draft, { sourcePrefix: "", outputPrefix: "" }])
                }
              >
                Add folder rule
              </button>
              <InfoTip label="About removing folder rules">
                Removing a rule keeps source assets. To delete stale project
                files, use vardum pull --delete when updating membership.
                Pulling without --delete drops their tracking; later cleanup
                must be manual.
              </InfoTip>
            </div>
            <div className="folder-rule-save-actions">
              <button
                type="button"
                disabled={saving || !dirty}
                onClick={() => {
                  setDraft(rules);
                  setDirty(false);
                }}
              >
                Discard changes
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={saving || !dirty}
              >
                {saving ? "Saving…" : "Save rules"}
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}

function VardItemDialog({
  item,
  isNew,
  source,
  workspaceSlug,
  saved,
  canEdit,
  onSave,
  onRemove,
  onClose,
}: {
  item: DraftItem;
  isNew: boolean;
  source?: SyncAsset;
  workspaceSlug?: string;
  saved?: VardItem;
  canEdit: boolean;
  onSave: (item: DraftItem) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(item);
  const transformed = Boolean(draft.transformation);
  const preview = sourcePreview(draft, workspaceSlug, source, saved);

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

        <div className="vard-item-preview">
          <VardFilePreview
            url={preview.url}
            mimeType={preview.mimeType}
            label={`Source preview of ${item.key}`}
            controls
          />
          <span>
            Source · {draft.versionId ? "Pinned version" : "Latest version"}
          </span>
        </div>
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
                  <FolderIcon /> {folder.name}
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
