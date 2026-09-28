import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/lib/domain";
import { voiceGmailSync } from "../src/lib/voice-gmail";

function fixture() {
  const session = createSession("session");
  session.call.id = "call";
  session.call.status = "active";
  const events: unknown[] = [];
  let open = true;
  const sync = voiceGmailSync(
    "session", "call", async () => session,
    () => open, (event) => events.push(event),
  );
  return { session, events, sync, close: () => { open = false; } };
}

test("live Gmail changes become trusted context once without generating speech", async () => {
  const f = fixture();
  f.session.gmail.status = "offered";
  await f.sync();
  await f.sync();
  f.session.gmail.status = "connected";
  await f.sync();
  await f.sync();
  f.session.gmail.status = "deferred";
  await f.sync();
  assert.equal(f.events.length, 3);
  for (const [i, status] of ["offered", "connected", "deferred"].entries()) {
    const e = f.events[i] as { type: string; item: { role: string; content: { text: string }[] } };
    assert.equal(e.type, "conversation.item.create");
    assert.equal(e.item.role, "system");
    assert.ok(e.item.content[0].text.includes(JSON.stringify({ status })));
    assert.match(e.item.content[0].text, /do not interrupt/);
  }
});

test("retired, replaced and ended calls cannot receive Gmail state", async () => {
  for (const invalid of ["retired", "replaced", "ended", "other-session"] as const) {
    const f = fixture();
    if (invalid === "retired") f.session.retiredAt = Date.now();
    if (invalid === "replaced") f.session.call.id = "new-call";
    if (invalid === "ended") f.session.call.status = "ended";
    if (invalid === "other-session") f.session.id = "other-session";
    await f.sync();
    assert.equal(f.events.length, 0, invalid);
  }
});

test("hangup during the state read prevents late context sends", async () => {
  const f = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let open = true;
  const sync = voiceGmailSync("session", "call", async () => {
    await pending;
    return f.session;
  }, () => open, (event) => f.events.push(event));
  const reading = sync();
  open = false;
  finish();
  await reading;
  await sync();
  assert.equal(f.events.length, 0);
});

test("same-status account changes refresh the verified address without exposing tokens or generating speech", async () => {
  const f = fixture();
  f.session.gmail = { status: "connected", email: "first@example.test", encryptedTokens: "private-token-payload" };
  await f.sync();
  await f.sync();
  f.session.gmail.email = "second@example.test";
  await f.sync();
  await f.sync();
  assert.equal(f.events.length, 2);
  const [first, second] = f.events as { type: string; item: { role: string; content: { text: string }[] } }[];
  assert.ok(first.item.content[0].text.includes(JSON.stringify({ status: "connected", email: "first@example.test" })));
  assert.ok(second.item.content[0].text.includes(JSON.stringify({ status: "connected", email: "second@example.test" })));
  assert.ok(!second.item.content[0].text.includes("first@example.test"));
  assert.ok(!JSON.stringify(f.events).includes("private-token-payload"));
  assert.ok(f.events.every((event) => (event as { type: string }).type === "conversation.item.create"));
  // A stale address attached to an unconnected record is not a verified fact.
  f.session.gmail.status = "deferred";
  await f.sync();
  const disconnected = f.events[2] as typeof first;
  assert.ok(disconnected.item.content[0].text.includes(JSON.stringify({ status: "deferred" })));
  assert.ok(!disconnected.item.content[0].text.includes("second@example.test"));
});
