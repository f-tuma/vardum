import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Fragment, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceDomain } from "./asset-api";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:5173/account",
  pretendToBeVisual: true,
});
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "Event", "MouseEvent", "CustomEvent", "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : Reflect.get(dom.window, key) });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });

const session = {
  user: { id: "user", name: "Original name", email: "owner@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  session: { id: "session", userId: "user", token: "session-token", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() },
};
type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let route: (call: Call) => Response | Promise<Response> = () => { throw new Error("Unexpected test request"); };
const originalFetch = globalThis.fetch;
// Better Auth captures fetch at initialization. This stable mock delegates to
// each test's routes and cannot contact any provider.
globalThis.fetch = async (urlInput, init) => {
  const path = new URL(String(urlInput), dom.window.location.origin).pathname;
  const call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as unknown : null };
  calls.push(call);
  if (path === "/api/auth/get-session") return Response.json(session);
  return route(call);
};
const { createRoot } = await import("react-dom/client");
const { AuthForm } = await import("./auth-form");
const { ProfileCard } = await import("./account-settings");
const { OrganizationInvitations } = await import("./organization-settings");
const { DomainSettings } = await import("./workspace-settings");
const { authClient } = await import("./auth-client");
const { toast } = await import("sonner");
authClient.hydrateSession(session);
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

const off = { passwordRecovery: false, emailChange: false, invitations: false };
const on = { passwordRecovery: true, emailChange: true, invitations: true };
const invitation = { id: "invitation", email: "teammate@example.test", role: "viewer", status: "pending", expiresAt: "2030-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" };
const pendingDomain: WorkspaceDomain = { domain: "assets.example.test", status: "pending", verifiedAt: null, target: "delivery.example.test", verification: { name: "_vardum-challenge.assets.example.test", value: "vardum-verification=token" } };

async function render(t: TestContext, content: ReactNode) {
  calls = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  await act(async () => { root.render(createElement(QueryClientProvider, { client }, content)); });
  t.after(async () => {
    await act(async () => { root.unmount(); client.clear(); await new Promise((resolve) => setTimeout(resolve, 15)); });
    container.remove();
  });
  return { container, client };
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
  assert.ok(found, `Button ${text} must be rendered`);
  return found;
}
function input(name: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  assert.ok(found, `Input ${name} must be rendered`);
  return found;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); }); await settle(); }
async function submit(form: HTMLFormElement) {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}
function mutations() { return calls.filter(({ method }) => method !== "GET"); }

// Render the consumers together to verify that availability is shared and that
// independent actions keep working in an SMTP-free deployment.
test("disabled email actions share one query while profile names and invitation revocation work", async (t) => {
  route = ({ path, method }) => {
    if (path === "/api/capabilities") return Response.json(off);
    if (path.endsWith("/invitations") && method === "GET") return Response.json({ invitations: [invitation] });
    if (path === "/api/auth/update-user") return Response.json({ status: true });
    if (path.endsWith("/invitations/invitation") && method === "DELETE") return Response.json({ success: true });
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  await render(t, createElement(Fragment, null, createElement(AuthForm), createElement(ProfileCard), createElement(OrganizationInvitations, { workspaceId: "workspace" })));
  await settle();
  assert.equal(calls.filter(({ path }) => path === "/api/capabilities").length, 1);
  assert.equal(button("Forgot password?").disabled, true);
  assert.equal(button("Invite").disabled, true);
  assert.equal(button("Resend").disabled, true);
  const emails = document.querySelectorAll<HTMLInputElement>('input[name="email"]');
  assert.equal(emails[1]?.disabled, true);
  assert.match(document.body.textContent!, /email delivery is not configured/);
  await click(button("Forgot password?"));
  await click(button("Invite"));
  await click(button("Resend"));
  assert.deepEqual(mutations(), []);
  // Even a crafted email value cannot send a change when capability is off.
  emails[1]!.value = "changed@example.test";
  input("name").value = "Saved name";
  await submit(button("Save").closest("form")!);
  assert.deepEqual(mutations().map(({ path }) => path), ["/api/auth/update-user"]);
  assert.deepEqual(mutations()[0]?.body, { name: "Saved name" });
  await click(button("Revoke"));
  await click(button("Revoke invitation"));
  assert.ok(mutations().some(({ method, path }) => method === "DELETE" && path.endsWith("/invitations/invitation")));
});

test("capability loading and failure show distinct messages; Retry enables recovery", async (t) => {
  let finish!: (response: Response) => void;
  route = ({ path }) => {
    assert.equal(path, "/api/capabilities");
    return new Promise((resolve) => { finish = resolve; });
  };
  await render(t, createElement(AuthForm));
  assert.equal(button("Forgot password?").disabled, true);
  assert.match(document.body.textContent!, /Checking email availability/);
  assert.doesNotMatch(document.body.textContent!, /not configured/);
  await act(async () => { finish(Response.json({ error: "Temporary outage" }, { status: 503 })); });
  await settle();
  assert.match(document.body.textContent!, /Could not check email availability/);
  assert.equal(button("Sign in").disabled, false);
  route = ({ path }) => { assert.equal(path, "/api/capabilities"); return Response.json(on); };
  await click(button("Retry"));
  assert.equal(button("Forgot password?").disabled, false);
  assert.equal(calls.filter(({ path }) => path === "/api/capabilities").length, 2);
});

test("sign in and sign up remain usable without email delivery", async (t) => {
  route = ({ path }) => {
    if (path === "/api/capabilities") return Response.json(off);
    if (path === "/api/auth/sign-in/email" || path === "/api/auth/sign-up/email") return Response.json(session);
    throw new Error(`Unexpected request ${path}`);
  };
  await render(t, createElement(AuthForm));
  await settle();
  input("email").value = "owner@example.test";
  input("password").value = "password123";
  await submit(button("Sign in").closest("form")!);
  await click(button("Create one"));
  input("name").value = "New user";
  await submit(button("Create account").closest("form")!);
  assert.deepEqual(mutations().map(({ path }) => path), ["/api/auth/sign-in/email", "/api/auth/sign-up/email"]);
});

test("recovery works when enabled and a form already open stops submitting when disabled", async (t) => {
  route = ({ path }) => {
    if (path === "/api/capabilities") return Response.json(on);
    if (path === "/api/auth/request-password-reset") return Response.json({ status: true });
    throw new Error(`Unexpected request ${path}`);
  };
  const { client } = await render(t, createElement(AuthForm));
  await settle();
  await click(button("Forgot password?"));
  input("email").value = "owner@example.test";
  await submit(button("Send reset link").closest("form")!);
  assert.equal(mutations().length, 1);
  assert.equal(mutations()[0]?.path, "/api/auth/request-password-reset");
  assert.match(document.body.textContent!, /If this email has an account/);
  await act(async () => { client.setQueryData(["deployment-capabilities"], off); });
  await settle();
  assert.equal(button("Send reset link").disabled, true);
  await submit(button("Send reset link").closest("form")!);
  assert.equal(mutations().length, 1);
});

test("email changes use the enabled action and generic inbox confirmation", async (t) => {
  const notices: string[] = [];
  t.mock.method(toast, "success", (message: string) => { notices.push(message); return "toast"; });
  route = ({ path }) => {
    if (path === "/api/capabilities") return Response.json(on);
    if (path === "/api/auth/update-user" || path === "/api/auth/change-email") return Response.json({ status: true });
    throw new Error(`Unexpected request ${path}`);
  };
  await render(t, createElement(ProfileCard));
  await settle();
  assert.equal(input("email").disabled, false);
  input("email").value = "new@example.test";
  await submit(button("Save").closest("form")!);
  assert.deepEqual(mutations().map(({ path }) => path), ["/api/auth/update-user", "/api/auth/change-email"]);
  assert.equal((mutations()[1]!.body as { newEmail: string }).newEmail, "new@example.test");
  assert.ok(notices.includes("Check your inbox to confirm the change."));
});

test("enabled invitation send and resend work; an open form cannot submit after disablement", async (t) => {
  route = ({ path, method }) => {
    if (path === "/api/capabilities") return Response.json(on);
    if (path.endsWith("/invitations") && method === "GET") return Response.json({ invitations: [invitation] });
    if (path.endsWith("/invitations") && method === "POST") return Response.json({ ...invitation, emailSent: true });
    if (path.endsWith("/resend")) return Response.json({ expiresAt: invitation.expiresAt });
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const { client } = await render(t, createElement(OrganizationInvitations, { workspaceId: "workspace" }));
  await settle();
  await click(button("Resend"));
  await click(button("Invite"));
  input("email").value = "new@example.test";
  await submit(button("Send invitation").closest("form")!);
  assert.equal(mutations().length, 2);
  assert.deepEqual(mutations()[1]?.body, { email: "new@example.test", role: "viewer" });
  await click(button("Invite"));
  const form = button("Send invitation").closest("form")!;
  await act(async () => { client.setQueryData(["deployment-capabilities"], off); });
  await settle();
  assert.equal(button("Send invitation").disabled, true);
  await submit(form);
  assert.equal(mutations().length, 2);
});

test("a missing domain target blocks save, verification and polling while removal stays usable", async (t) => {
  const intervals = t.mock.method(window, "setInterval");
  let record: WorkspaceDomain = { ...pendingDomain, target: null };
  route = ({ path, method }) => {
    assert.equal(path, "/api/workspaces/workspace/domain");
    if (method === "DELETE") record = { ...record, domain: null, status: "unconfigured" };
    assert.ok(method === "GET" || method === "DELETE");
    return Response.json(record);
  };
  await render(t, createElement(DomainSettings, { workspaceId: "workspace", canManage: true }));
  await settle();
  assert.equal(button("Save").disabled, true);
  assert.equal(button("Check DNS now").disabled, true);
  assert.match(document.body.textContent!, /no delivery target/);
  assert.equal(intervals.mock.callCount(), 0);
  await submit(button("Save").closest("form")!);
  await click(button("Check DNS now"));
  assert.deepEqual(mutations(), []);
  await click(button("Remove"));
  await click(button("Remove domain"));
  assert.deepEqual(mutations().map(({ method }) => method), ["DELETE"]);
});

test("editors and viewers see a permission reason without fetching or polling domain settings", async (t) => {
  const intervals = t.mock.method(window, "setInterval");
  route = () => { throw new Error("Unauthorized domain query"); };
  await render(t, createElement(DomainSettings, { workspaceId: "workspace", canManage: false }));
  await settle();
  assert.match(document.body.textContent!, /Only organization owners/);
  assert.deepEqual(calls, []);
  assert.equal(intervals.mock.callCount(), 0);
  assert.equal(document.querySelector("form"), null);
});

test("domain loading and failure are retryable before configured save and verification", async (t) => {
  let finish!: (response: Response) => void;
  route = () => new Promise((resolve) => { finish = resolve; });
  await render(t, createElement(DomainSettings, { workspaceId: "workspace", canManage: true }));
  assert.match(document.body.textContent!, /Loading domain settings/);
  await act(async () => { finish(Response.json({ error: "Temporary outage" }, { status: 503 })); });
  await settle();
  assert.match(document.body.textContent!, /Domain settings unavailable/);
  let record = { ...pendingDomain, status: "verified" };
  route = ({ path, method, body }) => {
    if (path.endsWith("/verify")) return Response.json({ ...record, checks: { txt: true, cname: true } });
    assert.equal(path, "/api/workspaces/workspace/domain");
    if (method === "PUT") record = { ...record, domain: (body as { domain: string }).domain };
    return Response.json(record);
  };
  await click(button("Retry"));
  assert.equal(button("Save").disabled, false);
  input("domain").value = "new-assets.example.test";
  await submit(button("Save").closest("form")!);
  await click(button("Check DNS now"));
  assert.deepEqual(mutations().map(({ method }) => method), ["PUT", "POST"]);
  assert.deepEqual(mutations()[0]?.body, { domain: "new-assets.example.test" });
});

test("configured pending domains poll and pause when the target disappears", async (t) => {
  let interval!: () => void;
  const start = t.mock.method(window, "setInterval", (callback: TimerHandler) => { interval = callback as () => void; return 42; });
  const stop = t.mock.method(window, "clearInterval", () => {});
  route = ({ path }) => {
    assert.ok(path === "/api/workspaces/workspace/domain" || path.endsWith("/domain/verify"));
    return Response.json(pendingDomain);
  };
  const { client } = await render(t, createElement(DomainSettings, { workspaceId: "workspace", canManage: true }));
  await settle();
  assert.equal(start.mock.callCount(), 1);
  assert.equal(mutations().length, 1);
  await act(async () => { interval(); });
  await settle();
  assert.equal(mutations().length, 2);
  await act(async () => { client.setQueryData(["workspace-domain", "workspace"], { ...pendingDomain, target: null }); });
  await settle();
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(button("Check DNS now").disabled, true);
});
