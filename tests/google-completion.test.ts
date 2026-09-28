import test from "node:test";
import assert from "node:assert/strict";
import {
  googleCompletionResponse,
  type GoogleCompletion,
} from "../src/lib/google-completion";
const origin = "https://persona.example";
test("voice OAuth popup outcomes finish locally without mounting another conversation", async () => {
  for (const result of [
    "connected",
    "cancelled",
    "unavailable",
    "error",
  ] as GoogleCompletion[]) {
    const response = googleCompletionResponse(origin, result, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const html = await response.text();
    assert.match(html, /Close window/);
    assert.match(html, /window\.close\(\)/);
    assert.match(html, /history\.replaceState/);
    assert.ok(!html.includes("https://"));
    assert.ok(!html.includes("__NEXT") && !html.includes("/api/session"));
    const nonce = /<script nonce="([\w-]+)">/.exec(html)![1];
    assert.ok(
      response.headers
        .get("content-security-policy")!
        .includes(`script-src 'nonce-${nonce}'`),
    );
    if (result === "connected") assert.match(html, /Gmail connected/);
    if (result === "cancelled") assert.match(html, /connection was cancelled/);
    if (result === "error") assert.match(html, /Gmail couldn’t connect/);
  }
});
test("ordinary same-tab OAuth retains the existing local result redirect", () => {
  for (const result of [
    "connected",
    "cancelled",
    "unavailable",
    "error",
  ] as GoogleCompletion[]) {
    const response = googleCompletionResponse(origin, result, false);
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      origin + "/?gmail=" + result,
    );
  }
});
