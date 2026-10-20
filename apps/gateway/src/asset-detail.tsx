import { isVideoMimeType, uploadAccept } from "@vardum/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockIcon,
  PencilIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type SyntheticEvent } from "react";
import { toast } from "sonner";
import { AssetThumb } from "@/components/asset-thumb";
import { OutputBackground, validOutputBackground } from "@/components/output-background";
import { OutputSafeArea, validOutputSafeArea } from "@/components/output-safe-area";
import { DeliveryChart } from "@/components/delivery-chart";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton, CopyIconButton } from "@/components/copy-button";
import { AppHeader, Page, PageHeader, PageSkeleton } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage, formatBytes, formatDimensions, formatMimeType, timeAgo } from "@/lib/format";
import {
  assetDeliveryPath,
  assetPreviewUrl,
  createTransformationUrl,
  deleteAsset,
  getAsset,
  getAssetDelivery,
  restoreAssetVersion,
  retryAssetVersion,
  renameAsset,
  setAssetVisibility,
  type AssetSummary,
  type TransformationInput,
} from "./asset-api";
import { assetVersionHistoryQueryOptions } from "./asset-queries";
import { folderCrumbs, statusBadge, UploadLimitDescription } from "./asset-dashboard";
import { assetOrigin } from "./asset-origin";
import { LinkedUses, useLibraryUses } from "./asset-uses";
import { useUploader } from "./use-uploader";
import type { WorkspaceRef } from "./workspace";

export function AssetDetail({
  workspace,
  assetId,
  fromPrefix,
  fromSearch,
}: {
  workspace: WorkspaceRef;
  assetId: string;
  fromPrefix?: string;
  fromSearch: string;
}) {
  const detail = useQuery({
    queryKey: ["asset", workspace.id, assetId],
    queryFn: () => getAsset(workspace.id, assetId),
    refetchInterval: (query) =>
      query.state.data?.status === "processing" ? 1500 : false,
  });

  if (detail.isPending || detail.isError) {
    const folder = fromPrefix ?? "";
    return (
      <>
        <AppHeader crumbs={[...folderCrumbs(workspace, folder, fromSearch), { label: "Asset" }]} />
        <Page id="main">
          {detail.isPending ? (
            <PageSkeleton />
          ) : (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Asset unavailable</AlertTitle>
              <AlertDescription>{detail.error.message}</AlertDescription>
            </Alert>
          )}
        </Page>
      </>
    );
  }

  return (
    <AssetDetailPage
      key={`${detail.data.id}:${detail.data.isPublic}`}
      asset={detail.data}
      workspace={workspace}
      fromPrefix={fromPrefix}
      fromSearch={fromSearch}
    />
  );
}

function AssetDetailPage({
  asset,
  workspace,
  fromPrefix,
  fromSearch,
}: {
  asset: AssetSummary;
  workspace: WorkspaceRef;
  fromPrefix?: string;
  fromSearch: string;
}) {
  const linked = useLibraryUses(workspace.id, "", "", asset.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"delete" | "visibility" | "version" | "rename" | null>(null);
  const [preview, setPreview] = useState<{ versionId: string | null; url: string } | null>(null);
  const path = assetDeliveryPath(workspace.slug, asset);
  const originalPreviewUrl = assetPreviewUrl(workspace.slug, asset, path);
  const previewUrl = preview?.versionId === asset.currentVersionId ? preview.url : originalPreviewUrl;
  const setPreviewUrl = useCallback((url: string) => {
    setPreview({ versionId: asset.currentVersionId, url });
  }, [asset.currentVersionId]);
  const url = new URL(path, window.location.origin).href;
  const badge = statusBadge(asset);
  const isVideo = isVideoMimeType(asset.mimeType);
  const origin = assetOrigin(asset.key, fromPrefix, fromSearch);
  const folder = origin.prefix;

  async function changeVisibility() {
    await setAssetVisibility(workspace.id, asset.id, !asset.isPublic);
    const previews = { queryKey: ["transformation-preview", workspace.id, asset.id] };
    await queryClient.cancelQueries(previews);
    queryClient.removeQueries(previews);
    await Promise.all(
      ["asset", "assets", "asset-uses", "vard", "vards", "audit", "workspace-overview"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, workspace.id] }),
      ),
    );
    toast.success(asset.isPublic ? "Asset is now private" : "Asset is now public");
  }

  async function removeAsset() {
    await deleteAsset(workspace.id, asset.id);
    await queryClient.invalidateQueries({ queryKey: ["assets", workspace.id] });
    toast.success(`“${asset.displayName}” deleted`);
    await navigate({
      to: "/workspaces/$workspaceId/assets",
      params: { workspaceId: workspace.id },
      search: origin,
    });
  }

  return (
    <>
      <AppHeader crumbs={[...folderCrumbs(workspace, folder, fromSearch), { label: asset.displayName }]} />
      <Page id="main">
        <PageHeader
          title={asset.displayName}
          description={<span className="font-mono">{asset.key}</span>}
          badge={
            <>
              {badge}
              <Badge variant="outline">
                {asset.isPublic ? <GlobeIcon data-icon="inline-start" /> : <LockIcon data-icon="inline-start" />}
                {asset.isPublic ? "Public" : "Private"}
              </Badge>
            </>
          }
          actions={
            <>
              {asset.currentVersionId && (
                <>
                  <CopyButton text={url} label="Copy URL" />
                  <a
                    href={path}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({ variant: "outline" })}
                  >
                    <ExternalLinkIcon data-icon="inline-start" />
                    Open
                  </a>
                </>
              )}
              {workspace.canEdit && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="outline" size="icon" aria-label="More actions" />}
                  >
                    <EllipsisIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setDialog("rename")}>
                      <PencilIcon />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDialog("version")}>
                      <UploadIcon />
                      Upload new version
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDialog("visibility")}>
                      {asset.isPublic ? <LockIcon /> : <GlobeIcon />}
                      Make {asset.isPublic ? "private" : "public"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
                      <Trash2Icon />
                      Delete asset
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          }
        />

        {asset.error && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Processing failed</AlertTitle>
            <AlertDescription>{asset.error}</AlertDescription>
          </Alert>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <div className="flex h-96 items-center justify-center overflow-hidden rounded-xl border bg-muted bg-cells lg:h-128">
              <AssetThumb
                url={previewUrl}
                mimeType={asset.mimeType}
                label={`Preview of ${asset.displayName}`}
                controls
              />
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              {[
                ["Type", asset.mimeType ?? "—"],
                ["Dimensions", formatDimensions(asset)],
                ["Size", asset.size ? formatBytes(asset.size) : "—"],
                ["Updated", timeAgo(asset.updatedAt)],
              ].map(([term, value]) => (
                <div key={term} className="flex flex-col gap-0.5">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="truncate font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-col gap-6">
            {workspace.canEdit && (
              <Card>
                <CardContent>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="asset-public">Public</FieldLabel>
                      <FieldDescription>
                        {asset.isPublic
                          ? "Anyone with the link can download it."
                          : "Only workspace members can download it."}
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="asset-public"
                      checked={asset.isPublic}
                      onCheckedChange={() => setDialog("visibility")}
                    />
                  </Field>
                </CardContent>
              </Card>
            )}
            {asset.currentVersionId && !isVideo && (
              <TransformationCard
                key={`${asset.currentVersionId}:${asset.isPublic}`}
                workspaceId={workspace.id}
                workspaceSlug={workspace.slug}
                asset={asset}
                originalUrl={path}
                onPreviewChange={setPreviewUrl}
              />
            )}
            <VersionHistory
              workspace={workspace}
              assetId={asset.id}
              currentVersionId={asset.currentVersionId}
              onUpload={() => setDialog("version")}
            />
            <DeliveryCard workspaceId={workspace.id} assetId={asset.id} />
          </div>
        </div>
        <LinkedUses key={asset.currentVersionId} workspace={workspace} source={asset} listing={linked} />
      </Page>

      {dialog === "rename" && (
        <RenameAssetDialog asset={asset} workspaceId={workspace.id} onClose={() => setDialog(null)} />
      )}
      <NewVersionDialog
        open={dialog === "version"}
        workspaceId={workspace.id}
        assetId={asset.id}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "visibility"}
        tone="neutral"
        title={asset.isPublic ? "Make this asset private?" : "Make this asset public?"}
        description={
          asset.isPublic
            ? "New requests will need workspace access. Copies already downloaded or cached cannot be revoked, and public Vards using it stop working anonymously."
            : "Anyone with a link will be able to download every version and variant."
        }
        confirmLabel={asset.isPublic ? "Make private" : "Make public"}
        onCancel={() => setDialog(null)}
        onConfirm={changeVisibility}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={`Delete “${asset.displayName}”?`}
        description="All versions and generated variants are deleted permanently. Remove linked uses first."
        confirmLabel="Delete asset"
        onCancel={() => setDialog(null)}
        onConfirm={removeAsset}
      />
    </>
  );
}

function RenameAssetDialog({ asset, workspaceId, onClose }: {
  asset: AssetSummary;
  workspaceId: string;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(asset.displayName);
  const [expectedName] = useState(asset.displayName);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError("");
    try {
      await renameAsset(workspaceId, asset.id, name.trim(), expectedName);
      await Promise.all(["asset", "assets", "vard", "vard-preview", "audit", "workspace-overview"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, workspaceId] }),
      ));
      toast.success("Asset renamed");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Rename failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>Rename asset</DialogTitle>
              <DialogDescription>The URL and all versions stay the same.</DialogDescription>
            </DialogHeader>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input id={`${id}-name`} value={name} required maxLength={255} aria-invalid={Boolean(error)}
                disabled={pending} onChange={(event) => setName(event.target.value)} />
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={pending || !name.trim() || name.trim() === expectedName}>
                {pending && <Spinner data-icon="inline-start" />}
                Save name
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewVersionDialog({
  open,
  workspaceId,
  assetId,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  assetId: string;
  onClose: () => void;
}) {
  const id = useId();
  const uploader = useUploader(workspaceId);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || !file.size) return;
    setPending(true);
    setError("");
    try {
      await uploader.uploadReplacement(assetId, file);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Upload failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          setError("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <DialogHeader>
              <DialogTitle>Upload new version</DialogTitle>
              <DialogDescription>
                The URL stays the same. Earlier versions stay restorable.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={`${id}-file`}>File</FieldLabel>
              <Input id={`${id}-file`} name="file" type="file" accept={uploadAccept} required />
              <UploadLimitDescription />
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Upload
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VersionHistory({
  workspace,
  assetId,
  currentVersionId,
  onUpload,
}: {
  workspace: WorkspaceRef;
  assetId: string;
  currentVersionId: string | null;
  onUpload: () => void;
}) {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState("");
  const historyOptions = useMemo(
    () => assetVersionHistoryQueryOptions(queryClient, workspace.id, assetId, currentVersionId),
    [queryClient, workspace.id, assetId, currentVersionId],
  );
  const history = useQuery(historyOptions);

  async function updateVersion(versionId: string, retry: boolean) {
    setPendingId(versionId);
    try {
      await (retry ? retryAssetVersion : restoreAssetVersion)(workspace.id, assetId, versionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["asset", workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ["assets", workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ["asset-uses", workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ["asset-versions", workspace.id, assetId] }),
      ]);
      toast.success(retry ? "Processing restarted" : "Version restored");
    } catch (cause) {
      toast.error(errorMessage(cause, "Version update failed"));
    } finally {
      setPendingId("");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Versions</CardTitle>
        {workspace.canEdit && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={onUpload}>
              <UploadIcon data-icon="inline-start" />
              New
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {history.isPending ? (
          <Spinner />
        ) : history.isError ? (
          <FieldError>{history.error.message}</FieldError>
        ) : (
          <ItemGroup>
            {history.data.versions.map((version) => {
              const retryable = version.status === "failed" && version.retryable;
              return (
                <Item key={version.id} size="xs">
                  <ItemContent>
                    <ItemTitle>
                      v{version.number}
                      {version.current && <Badge>Current</Badge>}
                      {version.status === "processing" && <Spinner />}
                      {version.status === "failed" && <Badge variant="destructive">Failed</Badge>}
                    </ItemTitle>
                    <ItemDescription>
                      {formatMimeType(version.mimeType)} · {formatBytes(version.size)} ·{" "}
                      {timeAgo(version.createdAt)}
                    </ItemDescription>
                    {version.error && <ItemDescription>{version.error}</ItemDescription>}
                  </ItemContent>
                  {workspace.canEdit &&
                    !version.current &&
                    (version.status === "ready" || retryable) && (
                      <ItemActions>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(pendingId)}
                          onClick={() => void updateVersion(version.id, retryable)}
                        >
                          {pendingId === version.id && <Spinner data-icon="inline-start" />}
                          {retryable ? "Retry" : "Restore"}
                        </Button>
                      </ItemActions>
                    )}
                </Item>
              );
            })}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}

function DeliveryCard({ workspaceId, assetId }: { workspaceId: string; assetId: string }) {
  const delivery = useQuery({
    queryKey: ["asset-delivery", workspaceId, assetId],
    queryFn: () => getAssetDelivery(workspaceId, assetId),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery</CardTitle>
      </CardHeader>
      <CardContent>
        {delivery.isPending ? (
          <Spinner />
        ) : delivery.isError ? (
          <FieldError>{delivery.error.message}</FieldError>
        ) : (
          <DeliveryChart summary={delivery.data} size="sm" />
        )}
      </CardContent>
    </Card>
  );
}

type DisplayFormat = NonNullable<TransformationInput["format"]> | "gif" | "svg" | "tiff";

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

function TransformationCard({
  workspaceId,
  workspaceSlug,
  asset,
  originalUrl,
  onPreviewChange,
}: {
  workspaceId: string;
  workspaceSlug: string;
  asset: AssetSummary;
  originalUrl: string;
  onPreviewChange: (url: string) => void;
}) {
  const { id: assetId, currentVersionId, width: sourceWidth, height: sourceHeight, mimeType: sourceMimeType } = asset;
  const id = useId();
  const sourceFormat = formatForMimeType(sourceMimeType);
  const [format, setFormat] = useState<DisplayFormat>(sourceFormat);
  const [transformation, setTransformation] = useState<TransformationInput | null>(null);
  const [background, setBackground] = useState<string | undefined>();
  const [padding, setPadding] = useState<number | undefined>();
  const [fit, setFit] = useState<TransformationInput["fit"]>("inside");
  const outputTransformation = useMemo(() => background !== undefined || Boolean(padding) ? {
    ...transformation,
    format: isOutputFormat(format) ? format : "png" as const,
    bg: background,
    pad: padding,
  } : transformation, [background, padding, format, transformation]);
  const [settledTransformation, setSettledTransformation] =
    useState<TransformationInput | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSettledTransformation(outputTransformation), 250);
    return () => window.clearTimeout(timeout);
  }, [outputTransformation]);

  const preview = useQuery({
    queryKey: ["transformation-preview", workspaceId, assetId, currentVersionId, originalUrl, settledTransformation],
    queryFn: () => {
      if (!settledTransformation) throw new Error("No transformation selected");
      return createTransformationUrl(workspaceId, assetId, settledTransformation);
    },
    enabled: Boolean(settledTransformation) && validOutputBackground(settledTransformation?.bg) && validOutputSafeArea(settledTransformation),
    staleTime: Infinity,
  });
  const generatedUrl = outputTransformation
    ? JSON.stringify(outputTransformation) === JSON.stringify(settledTransformation) && validOutputBackground(background) && validOutputSafeArea(outputTransformation) ? preview.data?.url : undefined
    : originalUrl;
  const generatedPreviewUrl = assetPreviewUrl(workspaceSlug, asset, generatedUrl ?? null);

  useEffect(() => {
    if (generatedPreviewUrl) onPreviewChange(generatedPreviewUrl);
  }, [generatedPreviewUrl, onPreviewChange]);

  function updatePreview(event: SyntheticEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const width = form.get("width");
    const height = form.get("height");
    const quality = form.get("quality");
    const rawPadding = form.get("pad");
    const nextPadding = typeof rawPadding === "string" && rawPadding ? Number(rawPadding) : undefined;
    let selectedFormat = String(form.get("format")) as DisplayFormat;
    const nextWidth = typeof width === "string" && width ? Number(width) : undefined;
    const nextHeight = typeof height === "string" && height ? Number(height) : undefined;
    const nextQuality = typeof quality === "string" && quality ? Number(quality) : undefined;
    if (
      nextWidth === (sourceWidth ?? undefined) &&
      nextHeight === (sourceHeight ?? undefined) &&
      selectedFormat === sourceFormat &&
      (nextQuality ?? 80) === 80 &&
      form.get("fit") === "inside" && !nextPadding
    ) {
      setTransformation(null);
      return;
    }
    if (selectedFormat === "svg" || nextPadding && !isOutputFormat(selectedFormat)) {
      selectedFormat = "png";
      setFormat("png");
    }
    const outputFormat = isOutputFormat(selectedFormat) ? selectedFormat : undefined;
    setTransformation({
      w: nextWidth,
      h: nextHeight,
      pad: nextPadding,
      fit: nextPadding ? "contain" : nextWidth || nextHeight ? String(form.get("fit") ?? fit) as TransformationInput["fit"] : undefined,
      format: outputFormat,
      q: outputFormat ? nextQuality : undefined,
    });
  }

  const fullUrl = generatedUrl ? new URL(generatedUrl, window.location.origin).href : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transform</CardTitle>
        <CardDescription>Resize or convert on the fly. The original is kept.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onChange={updatePreview} onSubmit={(event) => event.preventDefault()}>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor={`${id}-w`}>Width</FieldLabel>
                <Input
                  id={`${id}-w`}
                  name="width"
                  type="number"
                  min="1"
                  max="4096"
                  defaultValue={sourceWidth ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-h`}>Height</FieldLabel>
                <Input
                  id={`${id}-h`}
                  name="height"
                  type="number"
                  min="1"
                  max="4096"
                  defaultValue={sourceHeight ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-fit`}>Fit</FieldLabel>
                <NativeSelect id={`${id}-fit`} name="fit" value={fit} disabled={Boolean(padding)} onChange={(event) => setFit(event.target.value as TransformationInput["fit"])}>
                  <NativeSelectOption value="inside">Inside</NativeSelectOption>
                  <NativeSelectOption value="cover">Cover</NativeSelectOption>
                  <NativeSelectOption value="contain">Contain</NativeSelectOption>
                  <NativeSelectOption value="fill">Fill</NativeSelectOption>
                  <NativeSelectOption value="outside">Outside</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-format`}>Format</FieldLabel>
                <NativeSelect
                  id={`${id}-format`}
                  name="format"
                  value={format}
                  onChange={(event) => setFormat(event.target.value as DisplayFormat)}
                >
                  {sourceFormat === "svg" && <NativeSelectOption value="svg" disabled={background !== undefined || Boolean(padding)}>SVG</NativeSelectOption>}
                  {sourceFormat === "gif" && <NativeSelectOption value="gif" disabled={background !== undefined || Boolean(padding)}>GIF</NativeSelectOption>}
                  {sourceFormat === "tiff" && <NativeSelectOption value="tiff" disabled={background !== undefined || Boolean(padding)}>TIFF</NativeSelectOption>}
                  <NativeSelectOption value="webp">WebP</NativeSelectOption>
                  <NativeSelectOption value="avif">AVIF</NativeSelectOption>
                  <NativeSelectOption value="jpeg">JPEG</NativeSelectOption>
                  <NativeSelectOption value="png">PNG</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-q`}>Quality</FieldLabel>
                <Input
                  id={`${id}-q`}
                  name="quality"
                  type="number"
                  min="1"
                  max="100"
                  defaultValue="80"
                  disabled={!isOutputFormat(format)}
                />
              </Field>
            </div>
            <OutputSafeArea id={`${id}-safe-area`} transformation={outputTransformation} onChange={(pad) => {
              setPadding(pad);
              if (pad) { setFit("contain"); if (!isOutputFormat(format)) setFormat("png"); }
            }} />
            <OutputBackground id={`${id}-background`} value={background} onChange={(next) => {
              setBackground(next);
              if (next !== undefined && !isOutputFormat(format)) {
                setFormat("png");
                setTransformation((current) => ({ ...current, format: "png" }));
              }
            }} />
            <Field>
              <FieldLabel htmlFor={`${id}-url`}>URL</FieldLabel>
              <InputGroup>
                <InputGroupInput id={`${id}-url`} readOnly value={fullUrl} />
                <InputGroupAddon align="inline-end">
                  {preview.isFetching ? (
                    <Spinner />
                  ) : (
                    <CopyIconButton text={fullUrl} label="Copy transform URL" disabled={!fullUrl} />
                  )}
                </InputGroupAddon>
              </InputGroup>
              {preview.isError && <FieldError>{preview.error.message}</FieldError>}
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
