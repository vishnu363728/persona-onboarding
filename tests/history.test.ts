import test from "node:test";
import assert from "node:assert/strict";
import { createSession, addMessage, type Message } from "../src/lib/domain";
import {
  compactHistory,
  selectContextMessages,
  shortenMessage,
  HISTORY_CHARACTER_LIMIT,
  HISTORY_MESSAGE_LIMIT,
  CONTEXT_CHARACTER_LIMIT,
} from "../src/lib/history";
const message = (i: number, text = "message " + i): Message => ({
  id: String(i),
  role: i % 2 ? "assistant" : "user",
  channel: "text",
  text,
  at: i,
});

test("rolling history remains bounded without erasing saved facts, refusals, or retry IDs", () => {
  const s = createSession("long");
  s.profile.userName = { status: "known", value: "Riley" };
  s.gmail.status = "declined";
  s.call.preference = "deferred";
  s.processed = ["first-request"];
  for (let i = 0; i < 3000; i++) addMessage(s, message(i, "x".repeat(2000)));
  compactHistory(s);
  assert.ok(s.messages.length <= HISTORY_MESSAGE_LIMIT);
  assert.ok(
    s.messages.reduce((sum, m) => sum + m.text.length, 0) <=
      HISTORY_CHARACTER_LIMIT,
  );
  assert.equal(s.messages.at(-1)?.id, "2999");
  assert.equal(s.messages[0].role, "user");
  assert.ok(s.historyTrimmed! > 2900);
  assert.equal(s.profile.userName.value, "Riley");
  assert.equal(s.gmail.status, "declined");
  assert.equal(s.call.preference, "deferred");
  assert.deepEqual(s.processed, ["first-request"]);
  const trimmed = s.historyTrimmed;
  compactHistory(s);
  assert.equal(
    s.historyTrimmed,
    trimmed,
    "repeated saves must not repeatedly report trimming",
  );
});
test("oversized voice messages retain their beginning and end without emptying model context", () => {
  const s = createSession("voice");
  addMessage(s, {
    ...message(
      1,
      "Start context. " + "x".repeat(60000) + " Actually, call me Riley.",
    ),
    role: "user",
    channel: "voice",
  });
  const context = selectContextMessages(s);
  assert.match(context.at(-1)!.content, /^Start context/);
  assert.match(context.at(-1)!.content, /Actually, call me Riley\.$/);
  assert.match(context.at(-1)!.content, /Long message shortened/);
  assert.ok(
    context.reduce((sum, m) => sum + m.content.length, 0) <=
      CONTEXT_CHARACTER_LIMIT,
  );
  compactHistory(s);
  assert.ok(s.messages.at(-1)!.text.length <= 12000);
});
test("context is contiguous and counts interruption labels inside its character cap", () => {
  const s = createSession("window");
  for (let i = 0; i < 100; i++)
    addMessage(s, { ...message(i, "x".repeat(1000)), interrupted: true });
  const context = selectContextMessages(s);
  assert.ok(
    context.reduce((sum, m) => sum + m.content.length, 0) <=
      CONTEXT_CHARACTER_LIMIT,
  );
  assert.equal(context.length, 17);
  assert.ok(context.every((m) => m.content.startsWith("[Interrupted")));
});
test("shortening never leaves broken UTF-16 emoji at either cut", () => {
  const original = "🌱".repeat(20000);
  for (const limit of [12000, 11999, 2000, 1999]) {
    const result = shortenMessage(original, limit);
    assert.ok(result.length <= limit);
    assert.equal(result.isWellFormed(), true);
    assert.match(result, /Long message shortened/);
  }
});
