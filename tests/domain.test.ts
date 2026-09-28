import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  applyMemory,
  applyTurn,
  endCall,
  publicSession,
  addMessage,
  callLimitContinuation,
  markCallUnavailable,
  type MemoryPatch,
} from "../src/lib/domain";
import { contextMessages } from "../src/lib/prompt";
const empty: MemoryPatch = {
  agentName: null,
  userName: null,
  goal: null,
  callPreference: "unchanged",
  gmailPreference: "unchanged",
  helping: false,
};
test("accepts several volunteered details and a later correction without losing the goal", () => {
  const s = createSession("a");
  applyMemory(s, {
    ...empty,
    agentName: { status: "known", value: "Nova" },
    userName: { status: "known", value: "Alex" },
    goal: { status: "known", value: "Prepare for an interview" },
    helping: true,
  });
  applyMemory(s, { ...empty, userName: { status: "known", value: "Sam" } });
  assert.equal(s.profile.userName.value, "Sam");
  assert.equal(s.profile.goal.value, "Prepare for an interview");
  assert.equal(s.helping, true);
});
test("deferring or declining setup is distinct from unknown and never blocks helping", () => {
  const s = createSession("a");
  applyMemory(s, {
    ...empty,
    agentName: { status: "deferred", value: null },
    userName: { status: "declined", value: null },
    gmailPreference: "declined",
    helping: true,
  });
  assert.equal(s.profile.agentName.status, "deferred");
  assert.equal(s.profile.userName.status, "declined");
  assert.equal(s.gmail.status, "declined");
  assert.ok(s.helping);
});
test("no duplicate messages on retry and no repeated incoming calls after decline", () => {
  const s = createSession("a");
  const turn = {
    reply: "Let’s have a quick call.",
    memory: empty,
    action: "offer_call" as const,
  };
  applyTurn(s, turn, "abc");
  applyTurn(s, turn, "abc");
  assert.equal(s.messages.length, 2);
  assert.equal(s.call.attempts, 1);
  endCall(s, "declined");
  applyTurn(s, turn, "def");
  assert.equal(s.call.status, "declined");
  assert.equal(s.call.attempts, 1);
});
test("conversation cannot claim or clear a verified Gmail connection", () => {
  const s = createSession("a");
  s.gmail = {
    status: "connected",
    email: "a@example.com",
    encryptedTokens: "secret",
  };
  applyMemory(s, { ...empty, gmailPreference: "declined" });
  assert.equal(s.gmail.status, "connected");
  const p = publicSession(s);
  assert.equal("id" in p, false);
  assert.equal("processed" in p, false);
  assert.equal("encryptedTokens" in p.gmail, false);
  assert.equal(p.gmail.email, "a@example.com");
});
test("each session keeps separate memory and hangups preserve the conversation", () => {
  const a = createSession("a"),
    b = createSession("b");
  applyMemory(a, { ...empty, userName: { status: "known", value: "Alex" } });
  addMessage(a, {
    id: "voice-1",
    role: "user",
    channel: "voice",
    text: "Help me with a presentation",
    at: 1,
  });
  endCall(a, "ended");
  assert.equal(b.profile.userName.value, null);
  assert.equal(a.messages.at(-2)?.text, "Help me with a presentation");
  assert.equal(a.call.status, "ended");
});
test("only genuine server cap events receive a deterministic continuation", () => {
  const s = createSession("cap");
  endCall(s, "ended", "Call ended · demo token budget");
  const event = s.messages.at(-1)!;
  assert.ok(callLimitContinuation(event));
  assert.equal(
    callLimitContinuation({ ...event, role: "user", channel: "text" }),
    undefined,
  );
  assert.equal(
    callLimitContinuation({ ...event, id: "user-quote" }),
    undefined,
  );
  assert.equal(
    callLimitContinuation({ ...event, text: "Audio call ended" }),
    undefined,
  );
  assert.equal(
    callLimitContinuation({ ...event, text: "Gmail connected" }),
    undefined,
  );
});
test("a stale microphone failure cannot end a renewing transport", () => {
  const s = createSession("renewing");
  s.call = { id: "old", status: "renewing", attempts: 1 };
  const before = structuredClone(s);
  markCallUnavailable(s);
  assert.deepEqual(s, before);
});
test("late authenticated budget reason refines a generic browser hangup without duplicate events", () => {
  const s = createSession("race");
  s.call.id = "call";
  endCall(s, "ended");
  endCall(s, "ended", "Call ended · demo token budget");
  endCall(s, "ended");
  assert.equal(s.messages.length, 2);
  assert.match(
    callLimitContinuation(s.messages.at(-1)!)!.reply,
    /token spending limit/,
  );
});
test("interrupted speech is labeled and context remains bounded", () => {
  const s = createSession("a");
  for (let i = 0; i < 90; i++)
    addMessage(s, {
      id: String(i),
      role: "assistant",
      channel: "voice",
      text: "a".repeat(1000),
      at: i,
      interrupted: i === 89,
    });
  const context = contextMessages(s);
  assert.ok(context.length < 20);
  assert.match(context.at(-1)!.content, /Interrupted/);
});

test("explicit text refusals persist even without a previous call attempt", () => {
  for (const preference of ["declined", "deferred"] as const) {
    const s = createSession("pref-" + preference);
    applyMemory(s, { ...empty, callPreference: preference });
    applyTurn(
      s,
      { reply: "A call?", memory: empty, action: "offer_call" },
      "reply",
    );
    assert.equal(s.call.attempts, 0);
  }
});
test("an explicit change of mind can reopen Gmail after refusal", () => {
  const s = createSession("reopen");
  s.gmail.status = "declined";
  applyTurn(
    s,
    {
      reply: "The connection button is here.",
      memory: { ...empty, gmailPreference: "open" },
      action: "offer_gmail",
    },
    "reopen",
  );
  assert.equal(s.gmail.status, "offered");
});

test("deferring remaining setup preserves explicit refusals until reopened", () => {
  const s = createSession("keep-refusal");
  applyMemory(s, {
    ...empty,
    callPreference: "declined",
    gmailPreference: "declined",
  });
  applyMemory(s, {
    ...empty,
    callPreference: "deferred",
    gmailPreference: "deferred",
  });
  assert.equal(s.call.preference, "declined");
  assert.equal(s.gmail.status, "declined");
  applyMemory(s, { ...empty, callPreference: "open", gmailPreference: "open" });
  assert.equal(s.call.preference, "open");
  assert.equal(s.gmail.status, "offered");
  applyMemory(s, {
    ...empty,
    callPreference: "deferred",
    gmailPreference: "deferred",
  });
  assert.equal(s.call.preference, "deferred");
  assert.equal(s.gmail.status, "deferred");
});

test("replaying a completed turn cannot undo later memory or repeat its actions", () => {
  const s = createSession("retry");
  const original = {
    reply: "Nova it is — calling now.",
    memory: {
      ...empty,
      agentName: { status: "known" as const, value: "Nova" },
      userName: { status: "known" as const, value: "Alex" },
      gmailPreference: "declined" as const,
    },
    action: "offer_call" as const,
  };
  applyTurn(s, original, "first-turn");
  applyTurn(
    s,
    {
      reply: "Sam, let’s work on your outline.",
      memory: {
        ...empty,
        userName: { status: "known", value: "Sam" },
        gmailPreference: "open",
        helping: true,
      },
      action: "offer_gmail",
    },
    "correction",
  );
  const corrected = structuredClone(s);
  applyTurn(s, original, "first-turn");
  assert.deepEqual(s, corrected);

  s.processed.push("already-processed");
  const processed = structuredClone(s);
  applyTurn(s, original, "already-processed");
  assert.deepEqual(s, processed);
});

test("a call deferral stops ringing, retains the choice, and leaves an active call alone", () => {
  const s = createSession("later");
  applyTurn(
    s,
    { reply: "I’m calling now.", memory: empty, action: "offer_call" },
    "initial",
  );
  applyTurn(
    s,
    {
      reply: "We can stay here.",
      memory: { ...empty, callPreference: "deferred" },
      action: "none",
    },
    "later",
  );
  assert.equal(s.call.status, "declined");
  assert.equal(s.call.preference, "deferred");
  assert.equal(s.call.attempts, 1);
  assert.match(s.messages.find((m) => m.role === "event")!.text, /postponed/);
  applyTurn(
    s,
    {
      reply: "Another call?",
      memory: { ...empty, callPreference: "open" },
      action: "offer_call",
    },
    "reopened",
  );
  assert.notEqual(s.call.status, "ringing");
  assert.equal(s.call.attempts, 1);

  s.call.status = "active";
  applyMemory(s, { ...empty, callPreference: "deferred" });
  assert.equal(s.call.status, "active");
});

test("profile patches normalize values without retaining declined names or accepting empty corrections", () => {
  const s = createSession("fields");
  applyMemory(s, {
    ...empty,
    userName: { status: "known", value: "  Alex  " },
    goal: { status: "known", value: "Draft a presentation" },
  });
  assert.equal(s.profile.userName.value, "Alex");
  applyMemory(s, {
    ...empty,
    userName: { status: "known", value: "   " },
    goal: { status: "unknown", value: "stale" },
  });
  assert.equal(s.profile.userName.value, "Alex");
  assert.equal(s.profile.goal.value, "Draft a presentation");
  applyMemory(s, {
    ...empty,
    userName: { status: "declined", value: "stale Alex" },
    agentName: { status: "deferred", value: "stale Nova" },
  });
  assert.deepEqual(s.profile.userName, { status: "declined", value: null });
  assert.deepEqual(s.profile.agentName, { status: "deferred", value: null });
  applyMemory(s, {
    ...empty,
    agentName: { status: "known", value: "A".repeat(79) + "🌱B" },
  });
  assert.equal(s.profile.agentName.value, "A".repeat(79) + "🌱");
});

test("terminal call state prevents a false new call even if an old attempt counter is zero", () => {
  for (const status of ["ended", "failed", "missed", "declined"] as const) {
    const s = createSession(status);
    s.call.status = status;
    applyTurn(
      s,
      { reply: "I’m calling.", memory: empty, action: "offer_call" },
      "stale-counter",
    );
    assert.equal(s.call.status, status);
    assert.equal(s.call.attempts, 0);
  }
});
