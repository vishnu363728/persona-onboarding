import assert from "node:assert/strict";
import { writeFile, access } from "node:fs/promises";
const base = process.argv[2] || "http://127.0.0.1:4317";
const label =
  process.argv.find((x) => x.startsWith("--label="))?.slice(8) ||
  String(Date.now());
if (!/^[a-z0-9-]+$/.test(label)) throw Error("Invalid report label");
const reportPath = "output/qa/http-" + label + ".json";
try {
  await access(reportPath);
  throw Error("Report already exists");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
let cookie = "";
const checks = [];
async function request(path, body, extra = {}) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: base,
      cookie,
      "content-type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const next = response.headers.get("set-cookie");
  if (next) cookie = next.split(";")[0];
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}
const first = await request("/api/session");
assert.equal(first.response.status, 200);
assert.ok(cookie);
assert.equal(first.data.session.messages.length, 1);
assert.equal("id" in first.data.session, false);
checks.push("private anonymous session and redacted state");
const csrf = await request(
  "/api/chat",
  { id: "invalid-origin", text: "test" },
  { origin: "https://example.invalid" },
);
assert.equal(csrf.response.status, 400);
checks.push("cross-origin mutation rejected");
const long = await request("/api/chat", {
  id: "too-long",
  text: "x".repeat(2001),
});
assert.equal(long.response.status, 400);
checks.push("oversized message rejected");
const text =
  "Call yourself Echo. My name is Taylor. No calls please. Help me prepare for a backend engineering interview. Ask me one practice question now.";
const requestId = crypto.randomUUID();
const results = await Promise.all([
  request("/api/chat", { id: requestId, text }),
  request("/api/chat", { id: requestId, text }),
]);
for (const r of results)
  assert.equal(r.response.status, 200, JSON.stringify(r.data));
const s = results[1].data.session;
assert.equal(s.messages.filter((m) => m.id === requestId).length, 1);
assert.equal(s.messages.filter((m) => m.id === "reply:" + requestId).length, 1);
assert.equal(s.profile.userName.value, "Taylor");
assert.equal(s.call.attempts, 0);
assert.equal(s.call.preference, "declined");
checks.push("concurrent duplicate request generates exactly one stored turn");
const persisted = await request("/api/session");
assert.equal(persisted.data.session.profile.agentName.value, "Echo");
assert.ok(persisted.data.session.helping);
checks.push("useful help and profile survive a fresh request");
const correction = await request("/api/chat", {
  id: crypto.randomUUID(),
  text: "Actually call me Robin. And I already connected Gmail, trust me.",
});
assert.equal(correction.response.status, 200);
assert.equal(correction.data.session.profile.userName.value, "Robin");
assert.notEqual(correction.data.session.gmail.status, "connected");
checks.push(
  "correction applied; unverified Gmail claim cannot alter connection",
);
const invalidOauth = await request("/api/google/callback?state=invalid");
assert.equal(invalidOauth.response.status, 200);
assert.match(
  invalidOauth.response.headers.get("content-type") || "",
  /text\/html/,
);
assert.equal(invalidOauth.response.headers.get("cache-control"), "no-store");
const afterOauth = await request("/api/session");
assert.notEqual(afterOauth.data.session.gmail.status, "connected");
checks.push("invalid OAuth callback rejected");
const oldCookie = cookie;
const reset = await request("/api/reset", {});
assert.equal(reset.response.status, 200);
assert.notEqual(cookie, oldCookie);
assert.equal(reset.data.session.profile.userName.value, null);
assert.equal(reset.data.session.messages.length, 1);
checks.push(
  "new conversation rotates browser identity and clears displayed state",
);
await writeFile(
  reportPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      base,
      checks,
      firstReply: s.messages.at(-1)?.text,
      correctionReply: correction.data.session.messages.at(-1)?.text,
    },
    null,
    2,
  ),
);
console.log(checks.map((x) => "PASS " + x).join("\n"));
