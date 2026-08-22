import assert from "node:assert/strict";
import test from "node:test";
import { actionEmail } from "./mail-template.js";

test("action emails escape dynamic HTML and retain the plain-text URL", () => {
  const email = actionEmail({
    title: "Join <Workspace>",
    intro: 'Invited by "Owner" & team',
    action: "Accept",
    url: "https://example.com/accept?id=one&role=editor",
  });

  assert.match(email.html, /Join &lt;Workspace&gt;/);
  assert.match(email.html, /&quot;Owner&quot; &amp; team/);
  assert.match(email.html, /id=one&amp;role=editor/);
  assert.match(
    email.text,
    /Accept: https:\/\/example\.com\/accept\?id=one&role=editor/,
  );
});
