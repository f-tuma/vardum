import assert from "node:assert/strict";
import test from "node:test";
import { awaitGrant, loginUrl, newState, readGrant } from "./login.js";

test("a grant is only accepted for this login", () => {
  const state = "8b1f0a4e-0000-4000-8000-000000000000";
  const good = JSON.stringify({ state, key: "varda_abc", workspace: "ws_1" });
  assert.deepEqual(readGrant(good, state), {
    state,
    key: "varda_abc",
    workspace: "ws_1",
  });

  for (const [body, why] of [
    [
      JSON.stringify({ state: "other", key: "k", workspace: "w" }),
      "wrong state",
    ],
    [JSON.stringify({ key: "k", workspace: "w" }), "no state"],
    [JSON.stringify({ state, workspace: "w" }), "no key"],
    [JSON.stringify({ state, key: "", workspace: "w" }), "empty key"],
    [JSON.stringify({ state, key: "k" }), "no workspace"],
    [JSON.stringify([state, "k"]), "not an object"],
    ["null", "null"],
    ["not json", "not json"],
  ] as const)
    assert.equal(readGrant(body, state), null, why);
});

test("the login URL sends the key back to this process only", () => {
  const url = new URL(loginUrl("https://vardum.com", 54321, "nonce", "laptop"));
  assert.equal(url.origin, "https://vardum.com");
  assert.equal(url.pathname, "/cli-login");
  assert.equal(url.searchParams.get("callback"), "http://127.0.0.1:54321/");
  assert.equal(url.searchParams.get("state"), "nonce");
  assert.equal(url.searchParams.get("label"), "laptop");
});

// Stands in for the browser: posts a grant to the listener the CLI opened.
test("the listener takes the browser's grant and refuses anything else", async () => {
  const state = newState();
  const listener = awaitGrant(state);
  const port = await listener.listening;
  const callback = new URL(
    loginUrl("https://vardum.com", port, state, "test"),
  ).searchParams.get("callback")!;
  const post = (body: string) =>
    fetch(callback, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });

  const guessed = await post(
    JSON.stringify({ state: "guessed", key: "k", workspace: "w" }),
  );
  assert.equal(
    guessed.status,
    400,
    "another process must not be able to claim it",
  );

  const notPost = await fetch(callback);
  assert.equal(notPost.status, 405);
  assert.equal(notPost.headers.get("access-control-allow-origin"), "*");

  const granted = await post(
    JSON.stringify({ state, key: "varda_live", workspace: "ws_9" }),
  );
  assert.equal(granted.status, 204);
  assert.deepEqual(await listener.grant, {
    state,
    key: "varda_live",
    workspace: "ws_9",
  });
  listener.close();
});
