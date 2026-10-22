import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHistory } from "@tanstack/react-router";
import { createAppRouter } from "./router";

// Exercise the application's real route tree, search validators and router base.
for (const [url, route, search] of [
    ["/app/", "/", {}],
    ["/app/account", "/account", {}],
    ["/app/reset-password?token=a%2Fb&error=INVALID_TOKEN", "/reset-password", { token: "a/b", error: "INVALID_TOKEN" }],
    ["/app/accept-invitation?id=i%2F1", "/accept-invitation", { id: "i/1" }],
    ["/app/cli-login?callback=http%3A%2F%2F127.0.0.1%3A54321%2F&state=s%2B1&label=My+laptop&workspace=ws", "/cli-login", { callback: "http://127.0.0.1:54321/", state: "s+1", label: "My laptop", workspace: "ws" }],
  ] as const) test(`public ${url.split("?")[0]} matches its logical route`, async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }));
    await router.load();
    const match = router.state.matches.at(-1)!;
    assert.equal(match.routeId, route);
    assert.deepEqual(match.search, search);
    assert.equal(router.state.location.publicHref, url);
    assert.equal(router.state.location.pathname.startsWith("/app"), false);
    assert.equal(router.buildLocation({ to: "/" }).publicHref, "/app/");
    assert.equal(router.buildLocation({ to: "/account" }).publicHref, "/app/account");
});

test("workspace list/detail navigation and history preserve filters under one base", async () => {
  const initial = "/app/workspaces/ws/assets?prefix=brand%2F&q=icon";
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createAppRouter(history);
  await router.load();
  assert.equal(router.state.location.pathname, "/workspaces/ws/assets");
  assert.deepEqual(router.state.matches.at(-1)!.search, { prefix: "brand/", q: "icon" });
  const listKey = router.options.getScrollRestorationKey!(router.state.location);
  assert.equal(listKey, router.state.location.href);
  await router.navigate({ to: "/workspaces/$workspaceId/assets/$assetId", params: { workspaceId: "ws", assetId: "asset" }, search: { from: "brand/", q: "icon" } });
  await router.load();
  assert.equal(history.location.pathname, "/app/workspaces/ws/assets/asset");
  assert.equal(router.state.location.pathname, "/workspaces/ws/assets/asset");
  assert.deepEqual(router.state.matches.at(-1)!.search, { from: "brand/", q: "icon" });
  assert.notEqual(router.options.getScrollRestorationKey!(router.state.location), listKey);
  history.back();
  await router.load();
  assert.equal(router.state.location.publicHref, initial);
  assert.equal(router.options.getScrollRestorationKey!(router.state.location), listKey);
});
