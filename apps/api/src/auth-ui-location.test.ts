import assert from "node:assert/strict";
import test from "node:test";
import { authUiLocation } from "./auth-ui-location.js";

const origin = "https://vardum.example";
test("completed legacy UI redirects preserve raw query and fragment bytes", () => {
  for (const [before, after] of [
    ["/", "/app/"],
    ["/?error=INVALID_TOKEN", "/app/?error=INVALID_TOKEN"],
    [`${origin}/`, `${origin}/app/`],
    ["/app?invitation=a%2Fb", "/app/?invitation=a%2Fb"],
    ["/reset-password?token=a%2Fb%2B%3D&error=TOKEN_EXPIRED", "/app/reset-password?token=a%2Fb%2B%3D&error=TOKEN_EXPIRED"],
    ["/accept-invitation?id=i%2F1", "/app/accept-invitation?id=i%2F1"],
    ["/cli-login?callback=http%3A%2F%2F127.0.0.1%3A54321%2F&state=a%2Bb&label=My%20laptop&workspace=w#continue", "/app/cli-login?callback=http%3A%2F%2F127.0.0.1%3A54321%2F&state=a%2Bb&label=My%20laptop&workspace=w#continue"],
    [`${origin}/account?emailChanged=true`, `${origin}/app/account?emailChanged=true`],
  ]) assert.equal(authUiLocation(before!, origin), after);
});

test("auth compatibility cannot change another origin, delivery, API or a lookalike route", () => {
  for (const value of [
    "https://evil.example/?callbackURL=/account", "http://127.0.0.1:54321/?state=nonce", "//evil.example/account",
    "https://vardum.example.evil/account", "https://user@vardum.example/account", "http://vardum.example/account",
    "/api/auth/error?callbackURL=%2Faccount", "/w/private/icon?signature=a%2Fb", "/v/id?token=a%3D", "/assets/legacy",
    "/app/cli-login?callback=http%3A%2F%2F127.0.0.1%3A54321%2F", "/appfoo", "/accounting", "/apiary", "/cli/login", "/docs",
    "/workspaces/../api/auth", "/workspaces/%2e%2e/api/auth", "/workspaces\\evil", "not a URL",
  ]) assert.equal(authUiLocation(value, origin), value);
});
