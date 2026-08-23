import assert from "node:assert/strict";
import test from "node:test";
import { loopbackCallback } from "./loopback.js";

test("only a loopback callback may receive a CLI key", () => {
  for (const good of ["http://127.0.0.1:54321/", "http://localhost:8080/"])
    assert.notEqual(loopbackCallback(good), null, good);

  for (const bad of [
    // A crafted link must not be able to send a working key anywhere else.
    "https://evil.example.com/steal",
    "http://evil.example.com:80/",
    "http://127.0.0.1.evil.com:1234/",
    "https://127.0.0.1:54321/",
    "http://127.0.0.1/",
    "file:///etc/passwd",
    "not a url",
    "",
  ])
    assert.equal(loopbackCallback(bad), null, bad);
});
