import test from "node:test";
import assert from "node:assert/strict";
import { createSession, type Session } from "../src/lib/domain";
import { onboardingFocus } from "../src/lib/onboarding";
import { instructions, textMessages } from "../src/lib/prompt";
import { realtimeConfiguration } from "../src/lib/voice-config";

function namedSession() {
  const s = createSession("onboarding-fixture");
  s.profile.agentName = { status: "known", value: "Appy" };
  return s;
}

test("text names the agent before its eligible first call; voice never asks for that name", () => {
  const s = createSession("fresh-onboarding");
  assert.equal(onboardingFocus(s, "text").step, "agent_name");
  assert.equal(onboardingFocus(s, "voice").step, "user_name");
  s.profile.agentName = { status: "known", value: "Appy" };
  assert.equal(onboardingFocus(s, "text").step, "call");
  assert.equal(onboardingFocus(s, "voice").step, "user_name");
});

test("incoming and outgoing calls follow the same user-name, need, Gmail, help progression", () => {
  for (const direction of ["incoming", "outgoing"] as const) {
    const s = namedSession();
    s.call = { status: "active", attempts: 1, direction };
    assert.equal(onboardingFocus(s, "voice").step, "user_name", direction);
    s.profile.userName = { status: "known", value: "Mara" };
    assert.equal(onboardingFocus(s, "voice").step, "goal", direction);
    s.profile.goal = { status: "known", value: "Prepare for an interview" };
    assert.equal(onboardingFocus(s, "voice").step, "gmail", direction);
    s.gmail.status = "offered";
    assert.equal(onboardingFocus(s, "voice").step, "help", direction);
  }
});

test("deferred and declined names and needs count as handled instead of causing a loop", () => {
  for (const status of ["deferred", "declined"] as const) {
    const s = createSession(`skipped-${status}`);
    s.profile.agentName = { status, value: null };
    assert.equal(onboardingFocus(s, "text").step, "user_name");
    s.profile.userName = { status, value: null };
    assert.equal(onboardingFocus(s, "voice").step, "goal");
    s.profile.goal = { status, value: null };
    assert.equal(onboardingFocus(s, "voice").step, "gmail");
    s.gmail.status = status;
    assert.equal(onboardingFocus(s, "text").step, "help");
    assert.equal(onboardingFocus(s, "voice").step, "help");
  }
});

test("unavailable, skipped, attempted, and in-progress calls never become another first-call focus", () => {
  const s = namedSession();
  assert.equal(onboardingFocus(s, "text", false).step, "user_name");
  for (const preference of ["deferred", "declined"] as const) {
    s.call.preference = preference;
    assert.equal(onboardingFocus(s, "text").step, "user_name", preference);
  }
  s.call.preference = "open";
  s.call.attempts = 1;
  assert.equal(onboardingFocus(s, "text").step, "user_name");
  s.call.attempts = 0;
  const statuses: Session["call"]["status"][] = [
    "ringing", "connecting", "renewing", "active", "declined", "missed", "ended", "failed",
  ];
  for (const status of statuses) {
    s.call.status = status;
    assert.equal(onboardingFocus(s, "text").step, "user_name", status);
  }
});

test("offered, connected, deferred, and declined Gmail all allow help without another invitation", () => {
  const s = namedSession();
  s.call.attempts = 1;
  s.profile.userName = { status: "known", value: "Mara" };
  s.profile.goal = { status: "known", value: "Interview practice" };
  assert.equal(onboardingFocus(s, "voice").step, "gmail");
  for (const status of ["offered", "connected", "deferred", "declined"] as const) {
    s.gmail.status = status;
    for (const channel of ["text", "voice"] as const)
      assert.equal(onboardingFocus(s, channel).step, "help", `${status}/${channel}`);
  }
});

test("focus is advisory: task-first instructions coexist with unfinished optional onboarding", () => {
  const s = namedSession();
  s.profile.goal = { status: "known", value: "Draft an urgent extension request" };
  s.helping = true;
  const before = structuredClone(s);
  assert.equal(onboardingFocus(s, "voice").step, "user_name");
  for (const channel of ["text", "voice"] as const) {
    const prompt = instructions(s, channel, true);
    assert.match(prompt, /immediate need comes before setup/);
    assert.match(prompt, /none of these details blocks useful help/);
    assert.match(prompt, /finish that request first/);
    assert.match(prompt, /Draft an urgent extension request/);
  }
  assert.deepEqual(s, before, "selecting a focus must not mutate or complete profile fields");
});

test("each prompt receives its own channel focus and honors audio availability", () => {
  const s = namedSession();
  assert.match(instructions(s, "text", true), /"onboarding":\{"step":"call"\}/);
  assert.match(instructions(s, "voice", true), /"onboarding":\{"step":"user_name"\}/);
  assert.match(instructions(s, "text", true, false), /"onboarding":\{"step":"user_name"\}/);
  s.profile.userName = { status: "known", value: "Riley" };
  assert.match(instructions(s, "voice", true), /"onboarding":\{"step":"goal"\}/);
});

test("saved-memory refresh advances onboarding without turning the live response into a renewal wait", () => {
  const s = namedSession();
  s.profile.userName = { status: "known", value: "Riley" };
  const config = realtimeConfiguration(s, "gpt-realtime-2.1", true, "memory");
  assert.match(config.instructions, /"onboarding":\{"step":"goal"\}/);
  assert.match(config.instructions, /SAVED FACTS UPDATED DURING THIS TURN/);
  assert.match(config.instructions, /Continue the response naturally/);
  assert.doesNotMatch(config.instructions, /transport renewal|Wait for the user to speak|FIRST SPOKEN TURN/);
  assert.equal(config.model, "gpt-realtime-2.1");
});

test("only transport renewal waits; a fresh call leads onboarding with the saved identity", () => {
  const s = namedSession();
  const renewed = realtimeConfiguration(s, "gpt-realtime-2.1", true, true);
  assert.match(renewed.instructions, /transport renewal/);
  assert.match(renewed.instructions, /Wait for the user to speak/);
  assert.doesNotMatch(renewed.instructions, /SAVED FACTS UPDATED DURING THIS TURN|FIRST SPOKEN TURN/);
  const fresh = realtimeConfiguration(s, "gpt-realtime-2.1", true);
  assert.match(fresh.instructions, /FIRST SPOKEN TURN/);
  assert.match(fresh.instructions, /"value":"Appy"/);
  assert.doesNotMatch(fresh.instructions, /transport renewal|SAVED FACTS UPDATED DURING THIS TURN/);
});

test("spoken tangents and final corrections reach text and a callback alongside saved progress", () => {
  const s = namedSession();
  s.call = { status: "ended", attempts: 1, direction: "incoming" };
  s.profile.userName = { status: "known", value: "Riley" };
  s.profile.goal = { status: "known", value: "Plan my week" };
  s.gmail.status = "deferred";
  s.messages.push(
    { id: "spoken-detail", role: "user", channel: "voice", text: "Tuesday is my pottery class; keep that evening free.", at: 1 },
    { id: "interrupted-answer", role: "assistant", channel: "voice", text: "I can help you plan around Tuesday.", interrupted: true, at: 2 },
    { id: "last-correction", role: "user", channel: "voice", text: "Actually the class moved to Thursday. Gmail can wait.", at: 3 },
  );
  const textContext = JSON.stringify(textMessages(s, true, true));
  const callback = realtimeConfiguration(s, "gpt-realtime-2.1", true);
  for (const context of [textContext, callback.instructions]) {
    assert.match(context, /Tuesday is my pottery class/);
    assert.match(context, /Actually the class moved to Thursday/);
    assert.match(context, /Interrupted; user may not have heard all of this/);
    assert.match(context, /Riley/);
    assert.match(context, /deferred/);
  }
  assert.match(callback.instructions, /CALLBACK:/);
  assert.doesNotMatch(callback.instructions, /FIRST SPOKEN TURN:/);
});
