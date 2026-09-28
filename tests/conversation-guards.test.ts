import test from "node:test";
import assert from "node:assert/strict";
import { addMessage, applyTurn, createSession, turnSchema, type Session } from "../src/lib/domain";
import { getConversationGuard } from "../src/lib/conversation-guards";

function user(s: Session, text: string) {
  addMessage(s, { id: `u-${s.messages.length}`, role: "user", channel: "text", text, at: s.messages.length });
}

function assistant(s: Session, text: string) {
  addMessage(s, { id: `a-${s.messages.length}`, role: "assistant", channel: "text", text, at: s.messages.length });
}

test("standalone Gmail refusals persist a decline without changing names, task, or call choice", () => {
  for (const text of ["No Gmail", "No Gmail, please.", "Email isn't for me, let's leave that out.", "Don’t connect my Gmail.", "Please do not link my Gmail account.", "I don't want to connect Gmail", "I'd rather not link my Gmail"]) {
    const s = createSession(text);
    s.profile.userName = { status: "known", value: "Dev" };
    s.profile.goal = { status: "known", value: "Flatmate music note" };
    s.call.preference = "declined";
    user(s, text);
    const before = structuredClone(s);
    const turn = turnSchema.parse(getConversationGuard(s));
    assert.deepEqual(s, before, "guard must not mutate persisted state");
    assert.equal(turn.action, "none");
    assert.equal(turn.memory.gmailPreference, "declined");
    applyTurn(s, turn, `guard-${text}`);
    assert.equal(s.gmail.status, "declined");
    assert.deepEqual(s.profile, before.profile);
    assert.equal(s.call.preference, "declined");
    assert.equal(s.call.attempts, 0);
  }
});

test("quoted, hypothetical, task-bearing, and positive Gmail messages stay with the model", () => {
  for (const text of ['"No Gmail"', "'No Gmail'", "`No Gmail`", "```\nNo Gmail\n```", "My friend said no Gmail", "Roleplay: don't connect my Gmail", "If I said no Gmail, what would happen?", "No Gmail. Help me with my interview", "Don't connect my Gmail yet; draft the email", "Actually connect Gmail", "Email can wait", "No email, just a text draft"]) {
    const s = createSession(text);
    user(s, text);
    assert.equal(getConversationGuard(s), undefined, text);
  }
});

test("already connected Gmail refusal cannot claim disconnection or discard tokens", () => {
  const s = createSession("connected");
  s.gmail = { status: "connected", email: "verified@example.test", encryptedTokens: "private" };
  user(s, "No Gmail");
  const before = structuredClone(s);
  assert.equal(getConversationGuard(s), undefined);
  assert.deepEqual(s, before);
});

test("resume events and voice transcripts cannot reactivate an older text guard", () => {
  for (const role of ["event", "assistant", "user"] as const) {
    const s = createSession(role);
    user(s, "No Gmail");
    addMessage(s, { id: "newer", role, channel: role === "user" ? "voice" : "system", text: role === "user" ? "No Gmail" : "call ended", at: 9 });
    assert.equal(getConversationGuard(s), undefined);
  }
});

test("bare naming assent clarifies once then defers without inventing a name or ringing", () => {
  const s = createSession("assent");
  user(s, "yes");
  const first = turnSchema.parse(getConversationGuard(s));
  assert.equal(first.memory.agentName, null);
  assert.equal(first.action, "none");
  applyTurn(s, first, "first");
  user(s, "yeah!");
  const second = turnSchema.parse(getConversationGuard(s));
  assert.deepEqual(second.memory.agentName, { status: "deferred", value: null });
  applyTurn(s, second, "second");
  assert.equal(s.profile.agentName.status, "deferred");
  assert.equal(s.profile.agentName.value, null);
  assert.equal(s.call.status, "never");
  assert.equal(s.call.attempts, 0);
  assert.equal(s.call.preference, "deferred");
  assert.equal(s.gmail.status, "unknown");
  assert.match(second.reply, /hand with/);
});

test("assent to a named proposal, delegation question, or user-name question is not ambiguous agent naming", () => {
  for (const question of ["Should I go by Nova?", "How about calling me Sol?", "Would you like me to pick a name?", "What should I call you?", "Is your name Alex?", "What name did you have in mind?", "Would you like a call?"]) {
    const s = createSession(question);
    assistant(s, question);
    user(s, "yes");
    assert.equal(getConversationGuard(s), undefined, question);
  }
  const s = createSession("known");
  s.profile.agentName = { status: "known", value: "Sol" };
  user(s, "yes");
  assert.equal(getConversationGuard(s), undefined);
});

test("explicit agent-name choice or delegation still reaches the model", () => {
  for (const text of ["You choose", "Whatever, you decide", "Call yourself Nova", "Nova", "yes, call yourself Pip"]) {
    const s = createSession(text);
    user(s, text);
    assert.equal(getConversationGuard(s), undefined);
  }
});

test("saved GLM regression dialogue is corrected before phantom Nova and the Gmail refusal can persist", () => {
  const s = createSession("saved-glm-assent");
  user(s, "yes");
  assistant(s, "Great—what would you like to call me?");
  user(s, "yes");
  const guarded = turnSchema.parse(getConversationGuard(s));
  assert.equal(guarded.memory.agentName?.status, "deferred");
  assert.equal(guarded.memory.agentName?.value, null);
  assert.equal(guarded.action, "none");
  applyTurn(s, guarded, "saved-assent");
  assert.ok(!s.messages.some((m) => /Nova/.test(m.text)));
  assert.equal(s.call.attempts, 0);

  const gmail = createSession("saved-glm-gmail");
  gmail.profile.agentName = { status: "known", value: "Milo" };
  gmail.call.preference = "declined";
  user(gmail, "Email isn't for me, let's leave that out.");
  applyTurn(gmail, turnSchema.parse(getConversationGuard(gmail)), "saved-gmail");
  assert.equal(gmail.gmail.status, "declined");
  assert.equal(gmail.call.preference, "declined");
});

test("deferring unresolved naming pauses a first call until reopening and preserves stronger refusals", () => {
  for (const preference of [undefined, "open", "declined"] as const) {
    const s = createSession(`pause-${preference}`);
    s.call.preference = preference;
    user(s, "yes");
    assistant(s, "Great—what would you like to call me?");
    user(s, "yes");
    const turn = turnSchema.parse(getConversationGuard(s));
    assert.equal(turn.memory.callPreference, preference === "declined" ? "unchanged" : "deferred");
    applyTurn(s, turn, "defer");
    user(s, "🦆 keyboards should have a duck key lol");
    assert.equal(getConversationGuard(s), undefined);
    const attemptedCall = { ...turn, memory: { ...turn.memory, agentName: null, callPreference: "unchanged" as const }, action: "offer_call" as const };
    applyTurn(s, attemptedCall, "unsolicited");
    assert.equal(s.call.status, "never");
    assert.equal(s.call.attempts, 0);
    assert.equal(s.call.preference, preference === "declined" ? "declined" : "deferred");
    user(s, "Actually let's have a call now.");
    applyTurn(s, { ...attemptedCall, memory: { ...attemptedCall.memory, callPreference: "open" } }, "reopened");
    assert.equal(s.call.status, "ringing");
    assert.equal(s.call.attempts, 1);
  }
});
