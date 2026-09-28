import test from "node:test";
import assert from "node:assert/strict";
import { encryptTokens, decryptTokens } from "../src/lib/google";
process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
test("OAuth tokens round-trip encrypted and tampering is rejected", () => {
  const input = {
    access_token: "sensitive",
    refresh_token: "refresh",
    expiry: 1234,
  };
  const encoded = encryptTokens(input);
  assert.ok(!encoded.includes("sensitive"));
  assert.deepEqual(decryptTokens(encoded), input);
  const parts = encoded.split(".");
  parts[1] = Buffer.alloc(16).toString("base64url");
  assert.throws(() => decryptTokens(parts.join(".")));
  assert.notEqual(encryptTokens(input), encoded);
});
