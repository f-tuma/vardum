import assert from "node:assert/strict";
import test from "node:test";
import {
  domainIsVerified,
  normalizeCustomDomain,
  verifyDomainRecords,
} from "./domain-routes.js";

test("custom domains normalize IDNs and reject URLs or local hosts", () => {
  assert.equal(
    normalizeCustomDomain(" BÜCHER.Example. "),
    "xn--bcher-kva.example",
  );
  assert.throws(() => normalizeCustomDomain("https://assets.example.com"));
  assert.throws(() => normalizeCustomDomain("localhost"));
  assert.throws(() => normalizeCustomDomain("127.0.0.1"));
});

test("verification hinges on TXT: Cloudflare hides the CNAME", () => {
  assert.equal(domainIsVerified({ txt: true, cname: false }), true);
  assert.equal(domainIsVerified({ txt: false, cname: true }), false);
});

test("custom domain verification reports both TXT and CNAME records", async () => {
  const resolver = {
    resolveTxt: async (name: string) => {
      assert.equal(name, "_vardum-challenge.assets.example.com");
      return [["vardum-verification=token"]];
    },
    resolveCname: async (name: string) => {
      assert.equal(name, "assets.example.com");
      return ["delivery.example.com."];
    },
  };
  assert.deepEqual(
    await verifyDomainRecords(
      "assets.example.com",
      "token",
      "delivery.example.com",
      resolver,
    ),
    { txt: true, cname: true },
  );
});
