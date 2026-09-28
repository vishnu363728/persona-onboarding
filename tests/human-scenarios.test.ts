import test from "node:test";
import assert from "node:assert/strict";
import { applyMemory, applyTurn, memorySchema, type AgentTurn } from "../src/lib/domain";
import { baseInstructions } from "../src/lib/prompt";
import { beginHumanStep, canStartHumanTurn, checkHumanStep, createHumanSession, humanScenarios, validateHumanScenarios } from "../scripts/human-onboarding-scenarios";
import { humanHoldouts } from "../scripts/human-onboarding-holdouts";

const emptyMemory: AgentTurn["memory"] = { agentName: null, userName: null, goal: null, callPreference: "unchanged", gmailPreference: "unchanged", helping: false };
const scenario = (id: string) => humanScenarios.find((s) => s.id === id)!;

test("human corpus includes complete bounded journeys with explicit state expectations", () => {
  assert.deepEqual(validateHumanScenarios(), { scenarios: 8, turns: 34 });
  assert.ok(humanScenarios.every((s) => s.steps.every((step) => step.review.length > 20 && "action" in step.expect)));
});

test("holdouts use fresh names and topics with nine bounded turns and explicit expected actions", () => {
  assert.equal(humanHoldouts.length, 2);
  assert.equal(humanHoldouts.reduce((n, c) => n + c.steps.length, 0), 9);
  assert.ok(humanHoldouts.every((c) => !humanScenarios.some((old) => old.id === c.id)));
  assert.ok(humanHoldouts.every((c) => c.steps.every((s) => s.user.length <= 2000 && s.review && "action" in s.expect)));
  assert.deepEqual(humanHoldouts[0].steps.slice(0, 2).map((s) => s.user), ["yes", "yes"]);
});

test("provider-specific evaluation allowance preserves the full voice reservation", () => {
  assert.equal(canStartHumanTurn(360.02562, 2), true);
  assert.equal(canStartHumanTurn(373, 2), true);
  assert.equal(canStartHumanTurn(373.00001, 2), false);
  assert.equal(canStartHumanTurn(372, 3), true);
  assert.equal(canStartHumanTurn(372.00001, 3), false);
  assert.equal(canStartHumanTurn(350, 25), true);
  assert.equal(canStartHumanTurn(350.00001, 25), false);
  for (const [ledger, reserve] of [[NaN, 2], [-1, 2], [360, 0], [360, -2], [360, Infinity]]) assert.equal(canStartHumanTurn(ledger, reserve), false);
});

test("call fixture cannot hide a model that failed to initiate the call", () => {
  const c = scenario("interrupted-call-text-continuity");
  const s = createHumanSession(c);
  assert.throws(() => beginHumanStep(s, c.steps[1], 1), /did not ring/);
  beginHumanStep(s, c.steps[0], 0);
  const turn: AgentTurn = { reply: "Nova it is. I’m giving you a call.", memory: { ...emptyMemory, agentName: { value: "Nova", status: "known" } }, action: "offer_call" };
  applyTurn(s, turn, "first");
  assert.ok(Object.values(checkHumanStep(s, turn, c.steps[0])).every(Boolean));
  assert.match(beginHumanStep(s, c.steps[1], 1)!, /SIMULATED/);
  assert.equal(s.call.status, "ended");
  assert.equal(s.call.attempts, 1);
  assert.equal(s.profile.userName.value, "Kai");
  assert.ok(s.messages.some((m) => m.channel === "voice" && m.interrupted));
});

test("Gmail fixtures require a preceding offer and never fabricate tokens", () => {
  const c = scenario("gmail-cancel-and-reopen");
  const s = createHumanSession(c);
  assert.throws(() => beginHumanStep(s, c.steps[2], 2), /did not offer/);
  s.gmail.status = "offered";
  assert.match(beginHumanStep(s, c.steps[2], 2)!, /SIMULATED/);
  assert.equal(s.gmail.status, "offered");
  assert.equal(s.gmail.email, undefined);
  assert.match(beginHumanStep(s, c.steps[4], 4)!, /SIMULATED/);
  assert.equal(s.gmail.status, "connected");
  assert.equal(s.gmail.email, "verified@example.test");
  assert.equal(s.gmail.encryptedTokens, undefined);
});

test("state grader catches an announced but unapplied call, independently of reply wording", () => {
  const c = scenario("delegated-name-and-text-choice");
  const s = createHumanSession(c);
  const turn: AgentTurn = { reply: "I’m calling now.", memory: { ...emptyMemory, agentName: { value: "Nova", status: "known" } }, action: "none" };
  applyTurn(s, turn, "no-action");
  const checks = checkHumanStep(s, turn, c.steps[0]);
  assert.equal(checks.action, false);
  assert.equal(checks["call.status"], false);
  const announced: AgentTurn = { ...turn, action: "offer_call" };
  assert.equal(checkHumanStep(s, announced, c.steps[0]).callActionApplied, false);
});

test("global-skip scenario requires actual deferred state rather than a friendly acknowledgment", () => {
  const c = scenario("skip-all-and-get-help");
  const s = createHumanSession(c);
  const turn: AgentTurn = { reply: "No problem—what could you use a hand with?", memory: emptyMemory, action: "none" };
  applyTurn(s, turn, "skip-without-memory");
  const checks = checkHumanStep(s, turn, c.steps[0]);
  assert.equal(checks["profile.agentName.status"], false);
  assert.equal(checks["call.preference"], false);
  assert.equal(checks["gmail.status"], false);
});

test("text-only memory examples parse and cause the intended skip/forget transitions", () => {
  const examples = baseInstructions("text").split("\n").filter((line) => line.startsWith('{"agentName":')).map((line) => memorySchema.parse(JSON.parse(line)));
  assert.equal(examples.length, 2);
  assert.ok(!baseInstructions("voice").split("\n").some((line) => line.startsWith('{"agentName":')));
  const c = scenario("skip-all-and-get-help");
  const s = createHumanSession(c);
  applyMemory(s, examples[0]);
  assert.equal(s.call.preference, "deferred");
  assert.equal(s.gmail.status, "deferred");
  assert.equal(s.profile.agentName.status, "deferred");
  s.profile.userName = { value: "Morgan", status: "known" };
  s.profile.goal = { value: "Keep the draft", status: "known" };
  s.call.preference = "declined";
  applyMemory(s, examples[1]);
  assert.deepEqual(s.profile.userName, { value: null, status: "declined" });
  assert.equal(s.profile.goal.value, "Keep the draft");
  assert.equal(s.call.preference, "declined");
  assert.ok(!baseInstructions("text").includes("View Gmail connection"));
  assert.ok(baseInstructions("voice").includes("View Gmail connection"));
});
