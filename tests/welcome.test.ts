import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  refreshUntouchedWelcome,
  WELCOME_MESSAGE,
} from "../src/lib/domain";

const old = "Hey, I’m your new personal AI. What should you call me?";
const previous = "Hey, I’m your personal AI. Got a name in mind for me? No rush if not.";
test("new and untouched old conversations use the same direct introduction", () => {
  const s = createSession("new");
  assert.equal(s.messages[0].text, WELCOME_MESSAGE);
  assert.doesNotMatch(s.messages[0].text, /No rush/i);
  for (const greeting of [old, previous]) {
    s.messages[0].text = greeting;
    refreshUntouchedWelcome(s);
    assert.equal(s.messages[0].text, WELCOME_MESSAGE);
  }
  assert.equal(s.messages[0].id, "welcome");
});
test("the previous no-rush greeting remains a faithful record after a user has answered", () => {
  const s = createSession("engaged");
  s.messages[0].text = previous;
  s.messages.push({ id: "user", role: "user", channel: "text", text: "Call yourself Nova", at: 1 });
  refreshUntouchedWelcome(s);
  assert.equal(s.messages[0].text, previous);
});
test("greeting migration never rewrites an existing conversation or configured profile", () => {
  for (const used of [
    "message",
    "profile",
    "call",
    "gmail",
    "processed",
    "retired",
  ]) {
    const s = createSession(used);
    s.messages[0].text = old;
    if (used === "message")
      s.messages.push({
        id: "user",
        role: "user",
        text: "yes",
        channel: "text",
        at: 1,
      });
    if (used === "profile")
      s.profile.agentName = { value: "Nova", status: "known" };
    if (used === "call") s.call.attempts = 1;
    if (used === "gmail") s.gmail.status = "offered";
    if (used === "processed") s.processed.push("past");
    if (used === "retired") s.retiredAt = Date.now();
    refreshUntouchedWelcome(s);
    assert.equal(s.messages[0].text, old);
  }
});
