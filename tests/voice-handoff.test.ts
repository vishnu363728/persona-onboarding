import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  endCall,
  addMessage,
  type AgentTurn,
} from "../src/lib/domain";
import { waitForVoiceSettlement } from "../src/lib/voice-stop";

const cwd = process.cwd();
let directory: string;
let store: typeof import("../src/lib/store");
let chat: typeof import("../src/lib/chat");
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "persona-voice-handoff-"));
  process.chdir(directory);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL;
  process.env.DEMO_BUDGET_USD = "5";
  store = await import("../src/lib/store");
  chat = await import("../src/lib/chat");
});
after(async () => {
  process.chdir(cwd);
  await rm(directory, { recursive: true, force: true });
});
const turn: AgentTurn = {
  reply: "Let’s keep practicing that introduction.",
  memory: {
    agentName: null,
    userName: null,
    goal: null,
    callPreference: "unchanged",
    gmailPreference: "unchanged",
    helping: false,
  },
  action: "none",
};
async function fixture() {
  const s = createSession(crypto.randomUUID());
  s.call = { status: "active", attempts: 1, id: crypto.randomUUID() };
  endCall(s, "ended", "Audio call ended");
  await store.saveSession(s);
  await store.rawStore.write("budget", {
    cents: 500,
    reservations: { historic: 150, current: 100 },
  });
  return s;
}
test("text resume waits outside the session lock for final transcript and released voice allowance", async () => {
  const s = await fixture();
  let calls = 0;
  const resuming = chat.processChat(
    s.id,
    { id: "resume-after-ack", resume: true },
    async (current) => {
      calls++;
      assert.equal(current.messages.at(-1)!.text, "Focus on my design work");
      const reservation = await store.reserveBudget(1);
      await store.settleBudget(reservation, 1);
      return { turn };
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0, "provider ACK alone must not start paid text");
  await store.mutateSession(s.id, (current) =>
    addMessage(current, {
      id: "late-transcript",
      role: "user",
      channel: "voice",
      text: "Focus on my design work",
      at: Date.now(),
    }),
  );
  await store.settleBudget("current", 3);
  await store.rawStore.write("voice-usage:" + s.call.id, {
    sessionId: s.id,
    callId: s.call.id,
    finalized: true,
    settledCents: 3,
  });
  const result = await resuming;
  assert.equal(calls, 1);
  assert.equal(result.messages.at(-1)!.text, turn.reply);
  assert.deepEqual(await store.rawStore.read("budget"), {
    cents: 404,
    reservations: { historic: 150 },
  });
});

test("an immediate typed follow-up waits for final spoken detail and memory work before replying", async () => {
  const s = await fixture();
  let responded = false;
  const followup = chat.processChat(s.id, { id: "typed-after-hangup", text: "What day did I say?" }, async current => {
    responded = true;
    assert.equal(current.profile.userName.value, "Riley");
    assert.ok(current.messages.some(m => m.text === "Actually my interview is Thursday."));
    assert.equal(current.messages.at(-1)!.text, "What day did I say?");
    return { turn: { ...turn, reply: "Thursday." } };
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(responded, false);
  await store.mutateSession(s.id, current => {
    current.profile.userName = { status: "known", value: "Riley" };
    addMessage(current, { id: "last-spoken-detail", role: "user", channel: "voice", text: "Actually my interview is Thursday.", at: Date.now() });
  });
  await store.settleBudget("current", 3);
  await store.rawStore.write("voice-usage:" + s.call.id, { sessionId: s.id, callId: s.call.id, finalized: true, settledCents: 3 });
  const result = await followup;
  assert.equal(result.messages.at(-1)!.text, "Thursday.");
});
test("unverified final usage keeps its entire hold without a paid automatic reply or false budget error", async () => {
  const s = await fixture();
  await store.rawStore.write("voice-usage:" + s.call.id, {
    sessionId: s.id,
    callId: s.call.id,
    finalized: true,
    settledCents: null,
    proposedSettlementCents: 3,
  });
  const result = await chat.processChat(
    s.id,
    { id: "unknown-resume", resume: true },
    async () => {
      throw new Error("must not ask the provider for an optional continuation");
    },
  );
  assert.deepEqual(result.messages, s.messages);
  assert.deepEqual(await store.rawStore.read("budget"), {
    cents: 500,
    reservations: { historic: 150, current: 100 },
  });
});
test("an automatic resume waiting on old usage cannot speak over a replacement call", async () => {
  const s = await fixture();
  const resuming = chat.processChat(
    s.id,
    { id: "stale-auto-resume", resume: true },
    async () => {
      throw new Error("must not resume a different call");
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.mutateSession(s.id, (current) => {
    current.call.id = "replacement";
    current.call.status = "active";
  });
  await store.rawStore.write("voice-usage:" + s.call.id, {
    sessionId: s.id,
    callId: s.call.id,
    finalized: true,
    settledCents: 3,
  });
  const result = await resuming;
  assert.equal(result.call.id, "replacement");
  assert.equal(result.call.status, "active");
  assert.deepEqual(result.messages, s.messages);
});
test("receipt barrier requires exact session/call and actual settlement, and bounds stalled storage", async () => {
  for (const receipt of [
    { sessionId: "other", callId: "call", finalized: true, settledCents: 0 },
    { sessionId: "session", callId: "other", finalized: true, settledCents: 0 },
    {
      sessionId: "session",
      callId: "call",
      finalized: false,
      settledCents: null,
      proposedSettlementCents: 0,
    },
  ]) {
    assert.equal(
      await waitForVoiceSettlement(
        { read: async <T>() => receipt as T },
        "session",
        "call",
        5,
        1,
      ),
      "pending",
    );
  }
  assert.equal(
    await waitForVoiceSettlement(
      { read: async () => new Promise<never>(() => {}) },
      "session",
      "call",
      5,
      1,
    ),
    "pending",
  );
  assert.equal(
    await waitForVoiceSettlement(
      {
        read: async <T>() =>
          ({
            sessionId: "session",
            callId: "call",
            finalized: true,
            settledCents: 0,
          }) as T,
      },
      "session",
      "call",
      5,
      1,
    ),
    "settled",
  );
});
