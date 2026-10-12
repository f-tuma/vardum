import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UsageConsumer } from "./usage-api";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:5173/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "Document", "Event", "MouseEvent", "CustomEvent", "FormData", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : Reflect.get(dom.window, key) });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");
const { createRoot } = await import("react-dom/client");
const { UsagePage } = await import("./usage");
const { SidebarProvider } = await import("./components/ui/sidebar");
const { TooltipProvider } = await import("./components/ui/tooltip");
const { toast } = await import("sonner");
after(() => dom.window.close());

const original: UsageConsumer = {
  id: "consumer", name: "Marketing", kind: "first_party", revision: 7, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  destinations: [{ id: "destination", label: "Homepage", url: "https://site.example/home" }],
  bindings: [{ id: "binding", destinationId: "destination", mode: "manual_frozen", target: { kind: "asset", assetId: "asset" }, targetLabel: "Brand logo",
    current: { resolved: true, reason: null, scopeToken: "captured-scope", source: { assetId: "asset", versionId: "v2", number: 2, checksum: "checksum", fingerprint: "source-fingerprint" } }, latestEvidence: null, status: "unknown" }],
};
type Call = { path: string; method: string; body: Record<string, unknown> | null };
async function render(t: TestContext, options: { consumer?: UsageConsumer; mutation?: (call: Call) => Response | Promise<Response>; versionPage?: (url: URL) => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  let server = options.consumer ?? original;
  let readFailure = false;
  t.mock.method(toast, "success", () => "toast");
  t.mock.method(toast, "error", () => "toast");
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const requestUrl = new URL(String(url), dom.window.location.origin);
    const path = requestUrl.pathname;
    const call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null }; calls.push(call);
    if (call.method !== "GET") return options.mutation ? options.mutation(call) : Response.json({ ...server, revision: 8 });
    if (path.endsWith("/known-usages")) return Response.json({ consumers: [server], nextCursor: null });
    if (path.endsWith("/known-usages/consumer")) return readFailure ? Response.json({ error: "Temporary outage" }, { status: 503 }) : Response.json(server);
    if (path.endsWith("/assets/asset/versions")) return options.versionPage ? options.versionPage(requestUrl) : Response.json({ currentVersionId: "v2", versions: [1, 2].map((number) => ({ id: `v${number}`, number, status: "ready", filename: "logo.svg" })) });
    if (path.endsWith("/vards")) return Response.json({ vards: [{ id: "vard", name: "Brand website", itemCount: 1 }] });
    if (path.endsWith("/vards/vard/manifest")) return Response.json({ name: "Brand website", items: [{ id: "folder-output", assetId: "folder-asset", key: "brand/icons/info.svg", outputPath: "public/icons/info.svg", versionId: "folder-version", fingerprint: "folder-fingerprint" }] });
    if (path.endsWith("/assets")) return Response.json({ assets: [], folders: [], nextCursor: null });
    if (path.endsWith("/checks")) return Response.json({ checks: server.bindings[0]?.latestEvidence ? [server.bindings[0].latestEvidence] : [], nextCursor: null });
    throw new Error(`Unexpected read ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const content = createElement(SidebarProvider, null, createElement(TooltipProvider, null, createElement(UsagePage, { workspace: { id: "workspace", name: "Workspace", slug: "workspace", canEdit: true, canManage: true } })));
  const contextProps = { router, children: content };
  await act(async () => { await router.load(); root.render(createElement(QueryClientProvider, { client }, createElement(RouterContextProvider, contextProps))); });
  await settle();
  t.after(async () => { await act(async () => { root.unmount(); client.clear(); await new Promise((resolve) => setTimeout(resolve, 15)); }); container.remove(); });
  return { client, calls, setServer: (value: UsageConsumer) => { server = value; }, failRead: (value: boolean) => { readFailure = value; } };
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); }
function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll("button")].find((element) => { const clone = element.cloneNode(true) as HTMLElement; for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove(); return clone.textContent?.trim() === label; });
  assert.ok(result, `Button ${label} should render`); return result;
}
function dialog(): HTMLElement { const result = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1); assert.ok(result); return result; }
function field(label: string, scope: ParentNode = document): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const result = [...scope.querySelectorAll("label")].find((element) => element.textContent?.trim() === label); assert.ok(result, `Field ${label} should render`);
  const control = document.getElementById(result.htmlFor); assert.ok(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement); return control;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); await settle(); }
async function change(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")!.set!.call(control, value); control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); await settle();
}
async function submit(form: HTMLFormElement) { await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await settle(); }
function mutations(calls: Call[]) { return calls.filter(({ method }) => method !== "GET"); }

test("registered coverage and unresolved references are honest before any check", async (t) => {
  const { calls } = await render(t, { consumer: { ...original, bindings: [{ ...original.bindings[0]!, status: "unresolved", current: { resolved: false, reason: "Asset was deleted", source: null, scopeToken: "old-scope" } }] } });
  assert.match(document.body.textContent!, /1 registered consumers · 1 bindings/);
  assert.match(document.body.textContent!, /Coverage includes these records only/);
  assert.match(document.body.textContent!, /Brand logo/);
  assert.match(document.body.textContent!, /No recorded check/);
  assert.match(document.body.textContent!, /Unresolved reference/);
  assert.equal(button("Record check").disabled, true);
  assert.equal(mutations(calls).length, 0);
});
test("revision conflict keeps the draft and captured token, blocks repeated save, and failed reload retains it", async (t) => {
  const { calls, client, setServer, failRead } = await render(t, { mutation: () => Response.json({ error: "Consumer changed" }, { status: 409 }) });
  await click(button("Edit"));
  await change(field("Consumer name", dialog()), "Unsaved name");
  await act(async () => { client.setQueryData(["known-usages", "workspace"], { consumers: [{ ...original, revision: 9, name: "Remote" }] }); }); await settle();
  await submit(button("Save consumer", dialog()).closest("form")!);
  assert.equal(mutations(calls)[0]?.body?.expectedRevision, 7);
  assert.equal(mutations(calls)[0]?.body?.name, "Unsaved name");
  assert.equal(field("Consumer name", dialog()).value, "Unsaved name");
  assert.match(dialog().textContent!, /Your unsaved changes are kept/);
  await submit(button("Save consumer", dialog()).closest("form")!);
  assert.equal(mutations(calls).length, 1);
  failRead(true); await click(button("Reload and discard changes", dialog()));
  assert.equal(field("Consumer name", dialog()).value, "Unsaved name");
  assert.match(dialog().textContent!, /Temporary outage/);
  failRead(false); setServer({ ...original, revision: 9, name: "Fresh" }); await click(button("Reload and discard changes", dialog()));
  assert.equal(field("Consumer name", dialog()).value, "Fresh");
  await change(field("Consumer name", dialog()), "Saved after reload"); await submit(button("Save consumer", dialog()).closest("form")!);
  assert.equal(mutations(calls)[1]?.body?.expectedRevision, 9);
});
test("manual check starts empty and submits the observed historical version and explicit date", async (t) => {
  const { calls } = await render(t);
  await click(button("Record check"));
  assert.equal(field("Reported checked version", dialog()).value, "");
  assert.equal(field("Date and time checked", dialog()).value, "");
  await submit(button("Record manual check", dialog()).closest("form")!);
  assert.equal(mutations(calls).length, 0);
  await change(field("Date and time checked", dialog()), "2026-10-10T10:30");
  await change(field("Reported checked version", dialog()), "v1");
  await change(field("Release reference (optional)", dialog()), "release-42");
  await submit(button("Record manual check", dialog()).closest("form")!);
  const body = mutations(calls)[0]?.body;
  assert.equal(body?.reportedVersionId, "v1");
  assert.equal(body?.checkedAt, new Date("2026-10-10T10:30").toISOString());
  assert.equal(body?.expectedScopeToken, "captured-scope");
  assert.equal(body?.expectedRevision, 7);
  assert.equal(body?.releaseRef, "release-42");
  assert.equal(Object.hasOwn(body!, "actor"), false);
});
test("a concrete Vard folder output is picked by friendly label and keeps Vard, path, and asset identity", async (t) => {
  const { calls } = await render(t);
  await click(button("Edit")); await click(button("Add binding", dialog()));
  await click(button("Vard outputs", dialog()));
  await change(field("Vard", dialog()), "vard");
  await click(button("public/icons/info.svg · brand/icons/info.svg", dialog()));
  await submit(button("Save consumer", dialog()).closest("form")!);
  const bindings = mutations(calls)[0]?.body?.bindings as Array<{ target: unknown }>;
  assert.deepEqual(bindings[1]?.target, { kind: "vard_output", vardId: "vard", outputPath: "public/icons/info.svg", assetId: "folder-asset" });
});
test("a changed source retains the human report and its old destination scope", async (t) => {
  const binding = original.bindings[0]!;
  const evidence = { id: "check", bindingId: binding.id, checkedAt: "2026-10-01T10:00:00Z", recordedAt: "2026-10-01T11:00:00Z", actor: "user:reporter", source: { ...binding.current.source!, number: 1, versionId: "v1" }, scope: { destination: { ...original.destinations[0]!, url: "https://site.example/old-page" }, target: binding.target, mode: binding.mode, targetLabel: "Brand logo", outputConfiguration: "old-config" }, commitRef: "abc123", releaseRef: null, note: "Observed on the homepage" };
  await render(t, { consumer: { ...original, bindings: [{ ...binding, status: "source_changed", latestEvidence: evidence }] } });
  assert.match(document.body.textContent!, /Source changed since recorded check/);
  assert.match(document.body.textContent!, /Reported version 1/);
  assert.match(document.body.textContent!, /Version 2/);
  await click(button("Check history"));
  assert.match(dialog().textContent!, /Recorded by user:reporter/);
  assert.match(dialog().textContent!, /https:\/\/site.example\/old-page/);
  assert.match(dialog().textContent!, /Reported commit: abc123/);
  assert.match(dialog().textContent!, /current deployment is not verified/);
});

test("pending save keeps the dialog and captured draft, disables repeat submissions, and closes on acceptance", async (t) => {
  let finish!: (response: Response) => void;
  const { calls } = await render(t, { mutation: () => new Promise((resolve) => { finish = resolve; }) });
  await click(button("Edit")); await change(field("Consumer name", dialog()), "Pending name");
  const form = button("Save consumer", dialog()).closest("form")!;
  await submit(form); await submit(form);
  assert.equal(mutations(calls).length, 1);
  assert.equal(button("Save consumer", dialog()).disabled, true);
  assert.equal(field("Consumer name", dialog()).value, "Pending name");
  await act(async () => { finish(Response.json({ ...original, revision: 8, name: "Pending name" })); }); await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
});
test("HTTP URL validation describes its own field and an unrelated server error keeps entered values valid", async (t) => {
  const { calls } = await render(t, { mutation: () => Response.json({ error: "Temporary failure" }, { status: 503 }) });
  await click(button("Edit"));
  const url = field("Destination URL 1", dialog());
  await change(url, "ftp://site.example/home"); await submit(button("Save consumer", dialog()).closest("form")!);
  assert.equal(mutations(calls).length, 0);
  assert.equal(url.getAttribute("aria-invalid"), "true");
  assert.ok(document.getElementById(url.getAttribute("aria-describedby")!));
  await change(url, "https://site.example/edited"); await submit(button("Save consumer", dialog()).closest("form")!);
  assert.equal(url.value, "https://site.example/edited");
  assert.equal(url.getAttribute("aria-invalid"), "false");
  assert.match(dialog().textContent!, /Temporary failure/);
  assert.equal(button("Save consumer", dialog()).disabled, false);
});
test("manual check conflicts retain observed version and time until a deliberate reload", async (t) => {
  const { calls, failRead } = await render(t, { mutation: () => Response.json({ error: "Source scope changed" }, { status: 409 }) });
  await click(button("Record check"));
  await change(field("Date and time checked", dialog()), "2026-10-10T10:30"); await change(field("Reported checked version", dialog()), "v1");
  await submit(button("Record manual check", dialog()).closest("form")!);
  assert.equal(field("Reported checked version", dialog()).value, "v1");
  assert.equal(field("Date and time checked", dialog()).value, "2026-10-10T10:30");
  assert.equal(button("Record manual check", dialog()).disabled, true);
  await submit(button("Record manual check", dialog()).closest("form")!); assert.equal(mutations(calls).length, 1);
  failRead(true); await click(button("Reload and discard changes", dialog()));
  assert.equal(field("Reported checked version", dialog()).value, "v1");
  failRead(false); await click(button("Reload and discard changes", dialog()));
  assert.equal(field("Reported checked version", dialog()).value, "");
  assert.equal(field("Date and time checked", dialog()).value, "");
});

test("native date value survives another field render and is read explicitly when reporting", async (t) => {
  const { calls } = await render(t);
  await click(button("Record check"));
  const date = field("Date and time checked", dialog());
  // Native date controls and automation can set the element value before the
  // input event, without traversing React's text-input change tracker.
  await act(async () => {
    date.value = "2026-10-10T10:30";
    date.dispatchEvent(new Event("input", { bubbles: true }));
    date.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await change(field("Reported checked version", dialog()), "v1");
  await change(field("Release reference (optional)", dialog()), "release-native-date");
  assert.equal(date.value, "2026-10-10T10:30");
  await submit(button("Record manual check", dialog()).closest("form")!);
  assert.equal(mutations(calls)[0]?.body?.checkedAt, new Date("2026-10-10T10:30").toISOString());
});

test("101-version source permits an explicit pinned v1 report while older paging preserves the draft", async (t) => {
  const boundaries: Array<string | null> = [];
  const pinned: UsageConsumer = { ...original, bindings: [{ ...original.bindings[0]!, target: { kind: "vard_output", vardId: "vard", outputPath: "public/logo.svg", assetId: "asset" }, targetLabel: "Brand website / public/logo.svg", current: { ...original.bindings[0]!.current, source: { ...original.bindings[0]!.current.source!, versionId: "v1", number: 1 } } }] };
  const { calls } = await render(t, { consumer: pinned, versionPage: (url) => {
    const before = url.searchParams.get("before"); boundaries.push(before);
    const top = before ? Number(before) - 1 : 101;
    const numbers = Array.from({ length: Math.min(50, top) }, (_, index) => top - index);
    return Response.json({ currentVersionId: "v101", versions: numbers.map((number) => ({ id: `v${number}`, number, status: "ready", filename: "logo.svg" })), nextCursor: numbers.at(-1)! > 1 ? numbers.at(-1) : null });
  } });
  await click(button("Record check"));
  const select = field("Reported checked version", dialog()) as HTMLSelectElement;
  assert.equal(select.value, "");
  assert.equal([...select.options].some((option) => option.value === "v1"), false);
  await change(field("Date and time checked", dialog()), "2026-10-10T10:30");
  await change(field("Release reference (optional)", dialog()), "pinned-release");
  await click(button("Older versions", dialog())); await click(button("Older versions", dialog()));
  assert.deepEqual(boundaries, [null, "52", "2"]);
  assert.equal(field("Date and time checked", dialog()).value, "2026-10-10T10:30");
  assert.equal(field("Release reference (optional)", dialog()).value, "pinned-release");
  assert.equal(select.value, "", "Paging must not assume the currently resolved version was observed");
  assert.ok([...select.options].some((option) => option.value === "v1" && option.textContent?.includes("currently resolved")));
  await change(select, "v1"); await submit(button("Record manual check", dialog()).closest("form")!);
  assert.equal(mutations(calls)[0]?.body?.reportedVersionId, "v1");
  assert.equal(mutations(calls)[0]?.body?.checkedAt, new Date("2026-10-10T10:30").toISOString());
  assert.equal(mutations(calls)[0]?.body?.releaseRef, "pinned-release");
});

test("failed older-version paging retains selected version and draft and retries the same boundary", async (t) => {
  const boundaries: Array<string | null> = [];
  let failOlder = true;
  await render(t, { versionPage: (url) => {
    const before = url.searchParams.get("before"); boundaries.push(before);
    if (before && failOlder) { failOlder = false; return Response.json({ error: "Older page unavailable" }, { status: 503 }); }
    return Response.json({ currentVersionId: "v2", versions: [{ id: before ? "v1" : "v2", number: before ? 1 : 2, status: "ready", filename: "logo.svg" }], nextCursor: before ? null : 2 });
  } });
  await click(button("Record check"));
  await change(field("Date and time checked", dialog()), "2026-10-10T10:30");
  await change(field("Reported checked version", dialog()), "v2");
  await change(field("Commit reference (optional)", dialog()), "kept-commit");
  await click(button("Older versions", dialog()));
  assert.match(dialog().textContent!, /Older page unavailable/);
  assert.equal(field("Reported checked version", dialog()).value, "v2");
  assert.equal(field("Date and time checked", dialog()).value, "2026-10-10T10:30");
  assert.equal(field("Commit reference (optional)", dialog()).value, "kept-commit");
  assert.equal(button("Record manual check", dialog()).disabled, false);
  await click(button("Retry", dialog()));
  assert.deepEqual(boundaries, [null, "2", "2"]);
  assert.equal(field("Reported checked version", dialog()).value, "v2");
});
