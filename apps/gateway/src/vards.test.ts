import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VardEditorDefinition } from "@vardum/shared";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:5173/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Document", "Event", "MouseEvent", "CustomEvent", "FormData", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : Reflect.get(dom.window, key) });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");
const { createRoot } = await import("react-dom/client");
const { VardEditor } = await import("./vards");
const { SidebarProvider } = await import("./components/ui/sidebar");
const { toast } = await import("sonner");
after(() => dom.window.close());

const revision = `v1:${"a".repeat(64)}`;
const freshRevision = `v1:${"b".repeat(64)}`;
const original: VardEditorDefinition = {
  schema: 1, id: "vard", workspaceId: "workspace", name: "Original", isPublic: false, updatedAt: "2026-01-01", revision,
  folderRules: [{ sourcePrefix: "brand/", outputPrefix: "public/" }],
  items: [
    { id: "11111111-1111-4111-8111-111111111111", assetId: "asset", key: "logo.svg", outputPath: "logo.svg", versionId: null,
      pinned: true, pinnedVersionId: "missing-pin", transformation: null, writable: false, sourceChecksum: null,
      mimeType: "image/svg+xml", size: null, fingerprint: null, downloadUrl: null },
    { id: "22222222-2222-4222-8222-222222222222", assetId: "asset-2", key: "other.svg", outputPath: "other.svg", versionId: null,
      pinned: false, pinnedVersionId: null, transformation: { w: 32 }, writable: false, sourceChecksum: null,
      mimeType: "image/svg+xml", size: null, fingerprint: null, downloadUrl: null },
  ],
};
type Call = { url: string; path: string; method: string; body: Record<string, unknown> | null };
async function render(t: TestContext, options: {
  capability?: number;
  editor?: unknown;
  editorStatus?: number;
  editorRead?: () => Response | Promise<Response>;
  mutation?: (call: Call) => Response | Promise<Response>;
} = {}) {
  const calls: Call[] = [];
  let current = original;
  t.mock.method(toast, "success", () => "toast");
  t.mock.method(toast, "warning", () => "toast");
  t.mock.method(toast, "error", () => "toast");
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(input), dom.window.location.origin);
    const path = requestUrl.pathname;
    const call = { url: requestUrl.href, path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    calls.push(call);
    if (call.method !== "GET") {
      assert.ok(path.includes("/editor"), "No UI mutation may use a legacy route");
      return options.mutation ? options.mutation(call) : Response.json(current);
    }
    if (path === "/api/capabilities") return Response.json({ vardEditRevision: options.capability ?? 1 });
    if (path.endsWith("/editor")) return options.editorRead ? options.editorRead() : Response.json(options.editor ?? current, { status: options.editorStatus ?? 200 });
    if (path.endsWith("/manifest") || path.endsWith("/vards/vard")) return Response.json(current);
    if (path.endsWith("/sync/assets")) return Response.json({ assets: [], workspaceSlug: "workspace", nextCursor: null });
    if (path.endsWith("/vards")) return Response.json({ vards: [] });
    if (path.endsWith("/assets")) return Response.json({ assets: [{
      id: "asset-new", key: "fresh.svg", displayName: "Fresh", isPublic: false, currentVersionId: "current-new",
      latestVersionId: "current-new", status: "ready", error: null, mimeType: "image/svg+xml", size: 12,
      width: null, height: null, thumbnailUrl: null, updatedAt: "2026-01-01",
    }], folders: [], nextCursor: null });
    throw new Error(`Unexpected request ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const route = createRootRoute();
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const content = createElement(SidebarProvider, null, createElement(VardEditor, {
    workspace: { id: "workspace", name: "Workspace", slug: "workspace", canEdit: true, canManage: true }, vardId: "vard",
  }));
  const contextProps = { router, children: content };
  await act(async () => {
    await router.load();
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterContextProvider, contextProps)));
  });
  await settle();
  t.after(async () => {
    await act(async () => { root.unmount(); client.clear(); await new Promise((resolve) => setTimeout(resolve, 15)); });
    container.remove();
  });
  return { client, calls, setServer: (definition: VardEditorDefinition) => { current = definition; } };
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((element) => {
    // Decorative braille spinner frames are text nodes, but are aria-hidden.
    // Keep the pending-state assertions bound to the button's semantic label.
    const label = element.cloneNode(true) as HTMLElement;
    for (const hidden of label.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return label.textContent?.trim() === text;
  });
  assert.ok(found, `Button ${text} must be rendered`); return found;
}
function field(label: string, scope: ParentNode = document): HTMLInputElement {
  const found = [...scope.querySelectorAll("label")].find((element) => element.textContent?.trim() === label);
  assert.ok(found, `Field ${label} must be rendered`);
  const control = document.getElementById(found.htmlFor);
  assert.ok(control instanceof HTMLInputElement); return control;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); await settle(); }
async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function submit(form: HTMLFormElement) {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}
function mutations(calls: Call[]) { return calls.filter(({ method }) => method !== "GET"); }
function dialog() { const found = document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(found); return found; }
function fileButton() { const found = [...document.querySelectorAll("button")].find((element) => element.textContent?.includes("logo.svg")); assert.ok(found); return found; }

// This exercises rendered components and real query cache updates; browser layout QA remains separate.
test("item saves retain the full original baseline across refetch and remain open until acceptance", async (t) => {
  let finish!: (response: Response) => void;
  const { client, calls } = await render(t, { mutation: () => new Promise((resolve) => { finish = resolve; }) });
  await click(fileButton());
  const pane = dialog();
  await change(field("Project path", pane), "edited.svg");
  const refetched = { ...original, revision: freshRevision, items: [original.items[0]!] };
  await act(async () => { client.setQueryData(["vard-editor", "workspace", "vard"], refetched); });
  await settle();
  const form = button("Save", pane).closest("form")!;
  await submit(form); await submit(form);
  assert.equal(mutations(calls).length, 1);
  const body = mutations(calls)[0]!.body!;
  assert.equal(body.expectedRevision, revision);
  const items = body.items as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(({ id }) => id), original.items.map(({ id }) => id));
  assert.equal(items[0]?.outputPath, "edited.svg");
  assert.equal(items[0]?.versionId, "missing-pin");
  assert.deepEqual(items[1]?.transformation, { w: 32 });
  assert.equal(button("Save", pane).disabled, true);
  assert.equal(field("Project path", pane).value, "edited.svg");
  await act(async () => { finish(Response.json({ ...original, revision: freshRevision })); });
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test("a solid background is saved on the output while literal pins and other mappings are retained", async (t) => {
  const { calls } = await render(t);
  await click(fileButton());
  const pane = dialog();
  const format = pane.querySelector("select")!;
  await act(async () => { format.value = "png"; format.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  const backgroundLabel = [...pane.querySelectorAll("label")].find((label) => label.textContent === "Solid background")!;
  await click(document.getElementById(backgroundLabel.htmlFor)!);
  const hex = pane.querySelector<HTMLInputElement>('[aria-label="Background hex color"]')!;
  await change(hex, "#oops");
  assert.equal(hex.checkValidity(), false);
  assert.match(pane.textContent!, /six-digit hex/);
  await change(hex, "#050507");
  assert.equal(hex.checkValidity(), true);
  await submit(button("Save", pane).closest("form")!);
  const body = mutations(calls)[0]!.body!;
  const items = body.items as Array<Record<string, unknown>>;
  assert.equal(body.expectedRevision, revision);
  assert.equal(items[0]!.versionId, "missing-pin");
  assert.equal(items[0]!.id, original.items[0]!.id);
  assert.deepEqual(items[0]!.transformation, { format: "png", bg: "#050507" });
  assert.deepEqual(items[1]!.transformation, original.items[1]!.transformation);
  assert.equal(items[0]!.writable, false);
});

test("typed stale item conflict preserves the draft, does not retry, and deliberate reload fetches fresh editor and preview", async (t) => {
  const { calls, setServer } = await render(t, { mutation: () => Response.json({ code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision: freshRevision }, { status: 409 }) });
  await click(fileButton());
  await change(field("Project path", dialog()), "unsaved.svg");
  await submit(button("Save", dialog()).closest("form")!);
  assert.match(dialog().textContent!, /Your unsaved changes are kept/);
  assert.equal(field("Project path", dialog()).value, "unsaved.svg");
  await submit(button("Save", dialog()).closest("form")!);
  assert.equal(mutations(calls).length, 1);
  const before = calls.length;
  setServer({ ...original, name: "Latest", revision: freshRevision });
  await click(button("Reload and discard changes", dialog()));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.ok(calls.slice(before).some(({ path, method }) => path.endsWith("/editor") && method === "GET"));
  assert.ok(calls.slice(before).some(({ path, method }) => path.endsWith("/manifest") && method === "GET"));
  assert.equal(mutations(calls).length, 1);
  assert.match(document.body.textContent!, /Latest/);
});

test("settings and folder rules retain original values and tokens while dirty across metadata refresh", async (t) => {
  const { client, calls, setServer } = await render(t, { mutation: () => Response.json({ code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision: freshRevision }, { status: 409 }) });
  await click(button("Settings"));
  const name = field("Name");
  await change(name, "Unsaved name");
  await click(button("Folder rules"));
  await change(field("Workspace folder"), "draft/");
  await act(async () => { client.setQueryData(["vard-editor", "workspace", "vard"], { ...original, revision: freshRevision, name: "Remote name", isPublic: true, folderRules: [{ sourcePrefix: "remote/", outputPrefix: "new/" }] }); });
  await settle();
  assert.equal(field("Workspace folder").value, "draft/");
  assert.equal(field("Project folder").value, "public/");
  await submit(button("Save rules").closest("form")!);
  assert.equal(mutations(calls)[0]?.body?.expectedRevision, revision);
  assert.deepEqual(mutations(calls)[0]?.body?.folderRules, [{ sourcePrefix: "draft/", outputPrefix: "public/" }]);
  await click(button("Settings"));
  assert.equal(field("Name").value, "Unsaved name");
  await submit(button("Save").closest("form")!);
  assert.equal(mutations(calls)[1]?.body?.expectedRevision, revision);
  assert.equal(mutations(calls)[1]?.body?.name, "Unsaved name");
  assert.equal(mutations(calls)[1]?.body?.isPublic, false);
  setServer({ ...original, name: "Reloaded", revision: freshRevision, folderRules: [{ sourcePrefix: "reloaded/", outputPrefix: "new/" }] });
  await click(button("Reload and discard changes"));
  assert.equal(field("Name").value, "Reloaded");
  await click(button("Folder rules"));
  assert.equal(field("Workspace folder").value, "reloaded/");
  assert.equal(field("Project folder").value, "new/");
  assert.doesNotMatch(document.body.textContent!, /Your unsaved changes are kept/);
  await change(field("Workspace folder"), "again/");
  await submit(button("Save rules").closest("form")!);
  assert.equal(mutations(calls)[2]?.body?.expectedRevision, freshRevision);
});

test("pristine form hydration pairs displayed values with the refetched token before editing", async (t) => {
  const { client, calls } = await render(t);
  await click(button("Settings"));
  await act(async () => { client.setQueryData(["vard-editor", "workspace", "vard"], { ...original, revision: freshRevision, name: "Hydrated", isPublic: true }); });
  await settle();
  assert.equal(field("Name").value, "Hydrated");
  await change(field("Name"), "Changed");
  await submit(button("Save").closest("form")!);
  assert.equal(mutations(calls)[0]?.body?.expectedRevision, freshRevision);
  assert.equal(mutations(calls)[0]?.body?.isPublic, true);
});

for (const unsupported of [
  { name: "unsupported capability", capability: 0 },
  { name: "missing revision", editor: { ...original, revision: undefined } },
  { name: "guarded route 404", editor: { error: "Not found" }, editorStatus: 404 },
]) test(`${unsupported.name} disables all writes without legacy fallback`, async (t) => {
  const { calls } = await render(t, unsupported);
  assert.match(document.body.textContent!, /Vard editing unavailable/);
  assert.equal(button("Add asset").disabled, true);
  await click(button("Add asset"));
  await click(button("Settings"));
  assert.equal(field("Name").disabled, true);
  await submit(field("Name").closest("form")!);
  assert.equal(mutations(calls).length, 0);
});


test("adding an asset submits null for the new mapping and waits for acceptance", async (t) => {
  let finish!: (response: Response) => void;
  const { calls } = await render(t, { mutation: () => new Promise((resolve) => { finish = resolve; }) });
  await click(button("Add asset"));
  const pick = [...dialog().querySelectorAll("button")].find((element) => element.textContent?.includes("fresh.svg"));
  assert.ok(pick); await click(pick);
  assert.match(dialog().textContent!, /Add file/);
  await submit(button("Add file", dialog()).closest("form")!);
  const items = mutations(calls)[0]?.body?.items as Array<{ id: string | null; assetId: string }>;
  assert.deepEqual(items.map(({ id }) => id), [...original.items.map(({ id }) => id), null]);
  assert.equal(items[2]?.assetId, "asset-new");
  assert.equal(button("Add file", dialog()).disabled, true);
  await act(async () => { finish(Response.json({ ...original, revision: freshRevision })); });
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

test("deletion preserves its captured token and typed conflict has a deliberate reload action", async (t) => {
  const { client, calls } = await render(t, { mutation: () => Response.json({ code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision: freshRevision }, { status: 409 }) });
  await click(button("Settings"));
  await change(field("Name"), "Unsaved");
  await click(button("Delete"));
  await act(async () => { client.setQueryData(["vard-editor", "workspace", "vard"], { ...original, revision: freshRevision, name: "Remote" }); });
  await settle();
  await click(button("Delete Vard"));
  assert.equal(mutations(calls).length, 1);
  assert.equal(new URL(mutations(calls)[0]!.url).searchParams.get("expectedRevision"), revision);
  assert.match(document.body.textContent!, /Your unsaved changes are kept/);
  assert.equal(field("Name").value, "Unsaved");
});

test("other 409 errors retain the item draft without being treated as stale revisions", async (t) => {
  const { calls } = await render(t, { mutation: () => Response.json({ error: "Output paths collide" }, { status: 409 }) });
  await click(fileButton());
  await change(field("Project path", dialog()), "collision.svg");
  await submit(button("Save", dialog()).closest("form")!);
  assert.match(dialog().textContent!, /Output paths collide/);
  assert.doesNotMatch(dialog().textContent!, /Vard changed|Reload and discard changes/);
  assert.equal(field("Project path", dialog()).value, "collision.svg");
  assert.equal(mutations(calls).length, 1);
});

test("a missing guarded write route disables further edits while retaining the unsaved item", async (t) => {
  const { calls } = await render(t, { mutation: () => Response.json({ error: "Not found" }, { status: 404 }) });
  await click(fileButton());
  await change(field("Project path", dialog()), "unsaved.svg");
  await submit(button("Save", dialog()).closest("form")!);
  assert.equal(field("Project path", dialog()).value, "unsaved.svg");
  assert.equal(field("Project path", dialog()).disabled, true);
  assert.match(document.body.textContent!, /Update the server and reload the page/);
  assert.equal(mutations(calls).length, 1);
});


test("a failed conflict reload retains drafts and allows a later deliberate read retry", async (t) => {
  let editorFailure = false;
  const { calls } = await render(t, {
    editorRead: () => editorFailure ? Response.json({ error: "Temporary outage" }, { status: 503 }) : Response.json(original),
    mutation: () => Response.json({ code: "vard_revision_conflict", error: "Vard changed; reload before saving.", currentRevision: freshRevision }, { status: 409 }),
  });
  await click(fileButton());
  await change(field("Project path", dialog()), "kept.svg");
  await submit(button("Save", dialog()).closest("form")!);
  editorFailure = true;
  await click(button("Reload and discard changes", dialog()));
  assert.equal(field("Project path", dialog()).value, "kept.svg");
  assert.match(dialog().textContent!, /Temporary outage/);
  assert.equal(mutations(calls).length, 1);
  editorFailure = false;
  await click(button("Reload and discard changes", dialog()));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(mutations(calls).length, 1);
});
