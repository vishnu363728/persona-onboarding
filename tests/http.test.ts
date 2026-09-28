import test from "node:test";
import assert from "node:assert/strict";
import { failure } from "../src/lib/http";

test("storage outages return a clean recoverable message without provider diagnostics", async () => {
  const response = failure(
    new Error("Vercel Blob: Failed to fetch blob: 403 Forbidden"),
    503,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "The demo is temporarily unavailable. Please try again later.",
  });
});
