import test from "node:test";
import assert from "node:assert/strict";
import { createSession, addMessage, endCall } from "../src/lib/domain";
import { contextMessages, instructions, textMessages } from "../src/lib/prompt";
import {
  canStartJourneyTurn,
  journeys,
  reconstructJourneyTurn,
  validateJourneyPlan,
} from "../scripts/newjourney-evaluate";

test("shared prompts expose verified context and capabilities without leaking private session data", () => {
  const s = createSession("private-session-secret");
  s.gmail = {
    status: "connected",
    email: "verified@example.com",
    encryptedTokens: "encrypted-token-secret",
  };
  s.processed = ["private-request-secret"];
  for (const channel of ["text", "voice"] as const) {
    const prompt = instructions(s, channel, true, false);
    assert.ok(prompt.includes('"status":"connected"'));
    assert.ok(prompt.includes('"email":"verified@example.com"'));
    assert.match(prompt, /Audio calls are unavailable/);
    assert.match(prompt, /Gmail authorization is available/);
    assert.ok(!prompt.includes(s.id));
    assert.ok(!prompt.includes(s.gmail.encryptedTokens!));
    assert.ok(!prompt.includes(s.processed[0]));
  }
});

test("call eligibility in the prompt follows terminal state, not only a zero counter", () => {
  const s = createSession("calls");
  assert.ok(
    instructions(s, "text", true).includes('"firstIncomingCallRemaining":true'),
  );
  endCall(s, "failed");
  assert.ok(
    instructions(s, "text", true).includes(
      '"firstIncomingCallRemaining":false',
    ),
  );
});

test("post-call context preserves user facts and distinguishes unheard speech from typed replies", () => {
  const s = createSession("continuity");
  addMessage(s, {
    id: "spoken-name",
    role: "user",
    channel: "voice",
    text: "Actually, call me Sam.",
    at: 1,
  });
  addMessage(s, {
    id: "last-spoken",
    role: "assistant",
    channel: "voice",
    text: "Sam, the first interview question is",
    at: 2,
    interrupted: true,
  });
  endCall(s, "ended");
  addMessage(s, {
    id: "text-reply",
    role: "assistant",
    channel: "text",
    text: "We can continue here.",
    at: 3,
  });
  const context = contextMessages(s);
  assert.ok(
    context.some(
      (message) =>
        message.role === "user" && message.content === "Actually, call me Sam.",
    ),
  );
  assert.match(
    context.find((message) => message.content.includes("first interview"))!
      .content,
    /Interrupted; user may not have heard/,
  );
  assert.equal(context.at(-1)!.content, "We can continue here.");
});

test("memory corrections and capability changes preserve the cached dialogue prefix", () => {
  const s = createSession("session-one");
  addMessage(s, {
    id: "first",
    role: "user",
    channel: "text",
    text: "I'm Jordan.",
    at: 1,
  });
  const first = textMessages(s, false, false);
  s.profile.userName = { value: "Riley", status: "known" };
  s.call.id = "private-provider-call-id";
  s.call.startedAt = 12345;
  s.gmail = {
    status: "connected",
    email: "verified@example.com",
    encryptedTokens: "never-in-prompt",
  };
  addMessage(s, {
    id: "second",
    role: "assistant",
    channel: "text",
    text: "What can I help with?",
    at: 2,
  });
  addMessage(s, {
    id: "third",
    role: "user",
    channel: "text",
    text: "Actually Riley. Help me prepare for an interview.",
    at: 3,
  });
  const next = textMessages(s, true, true);
  assert.deepEqual(next.slice(0, first.length - 1), first.slice(0, -1));
  const state = next.at(-1)!;
  assert.equal(state.role, "system");
  assert.match(state.content, /Riley/);
  assert.match(state.content, /Audio calls are available/);
  assert.match(state.content, /verified@example.com/);
  assert.ok(!state.content.includes("private-provider-call-id"));
  assert.ok(!state.content.includes("12345"));
  assert.ok(!JSON.stringify(next).includes("never-in-prompt"));
  assert.equal(next.at(-2)?.role, "user");
});

test("journey evaluations preserve a full voice reservation even during a text reservation", () => {
  assert.equal(canStartJourneyTurn(338.120905, 25), true);
  assert.equal(canStartJourneyTurn(350, 25), true);
  assert.equal(canStartJourneyTurn(350.00001, 25), false);
  assert.equal(canStartJourneyTurn(373, 2), true);
  assert.equal(canStartJourneyTurn(373.00001, 2), false);
  for (const invalid of [375, 500, -1, NaN, Infinity])
    assert.equal(canStartJourneyTurn(invalid), false);
  const plan = validateJourneyPlan();
  assert.equal(plan.journeys, 7);
  assert.equal(plan.turns, 28);
  assert.ok(plan.maxUserCharacters <= 2000);
});

test("journey call and OAuth fixtures cannot manufacture preceding onboarding success", () => {
  const call = journeys.find((j) => j.id === "ambiguous-name-interrupted-call")!
    .steps[2].before!;
  const s = createSession("offline-fixture");
  assert.throws(() => call(s), /did not ring/);
  s.call.status = "ringing";
  s.call.attempts = 1;
  assert.match(call(s), /SIMULATED/);
  assert.equal(s.call.status, "ended");
  assert.equal(s.call.attempts, 1);
  assert.equal(s.profile.userName.value, "Jordan");
  assert.ok(s.messages.some((m) => m.channel === "voice" && m.interrupted));

  const consent = journeys.find((j) => j.id === "refusals-explicit-reopening")!
    .steps[2].before!;
  assert.throws(() => consent(s), /was not offered/);
  s.gmail.status = "offered";
  assert.match(consent(s), /SIMULATED/);
  assert.equal(s.gmail.status, "connected");
  assert.equal(s.gmail.email, "ren@example.test");
  assert.equal(s.gmail.encryptedTokens, undefined);
});

test("targeted journey replay restores saved turns instead of rerunning or replacing them", () => {
  const memory = {
    agentName: null,
    userName: { value: "Lee", status: "known" },
    goal: { value: "Write the thank-you", status: "known" },
    callPreference: "declined",
    gmailPreference: "deferred",
    helping: true,
  };
  const report = {
    journeys: [
      {
        id: "task-first-then-introductions",
        dialogue: [
          {
            user: "Original request",
            assistant: "The saved draft",
            action: "none",
            memory,
          },
          {
            user: "The exact saved revision request",
            assistant: "Do not replay this target response",
            action: "none",
            memory,
          },
        ],
      },
    ],
  };
  const s = reconstructJourneyTurn(report, "task-first-then-introductions", 2);
  assert.equal(s.profile.userName.value, "Lee");
  assert.equal(s.gmail.status, "deferred");
  assert.equal(s.call.preference, "declined");
  assert.equal(s.messages.at(-1)?.text, "The exact saved revision request");
  assert.equal(
    s.messages.filter((m) => m.text === "The saved draft").length,
    1,
  );
  assert.ok(
    !s.messages.some((m) => m.text === "Do not replay this target response"),
  );
  assert.throws(
    () => reconstructJourneyTurn(report, "task-first-then-introductions", 3),
    /incomplete/,
  );
  assert.throws(
    () => reconstructJourneyTurn(null, "task-first-then-introductions", 2),
    /Saved journey required/,
  );
  assert.equal(
    reconstructJourneyTurn(
      null,
      "ambiguous-name-interrupted-call",
      1,
    ).messages.at(-1)?.text,
    "yes",
  );
});
