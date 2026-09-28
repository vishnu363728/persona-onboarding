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
const previous = process.cwd();
let temporary = "";
let store: typeof import("../src/lib/store");
let chat: typeof import("../src/lib/chat");
let retireConversation: typeof import("../src/lib/reset").retireConversation;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "persona-chat-journey-"));
  process.chdir(temporary);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL;
  store = await import("../src/lib/store");
  chat = await import("../src/lib/chat");
  ({ retireConversation } = await import("../src/lib/reset"));
});
after(async () => {
  process.chdir(previous);
  await rm(temporary, { recursive: true, force: true });
});
const turn: AgentTurn = {
  reply: "Let’s work on your interview.",
  memory: {
    agentName: null,
    userName: null,
    goal: null,
    callPreference: "unchanged",
    gmailPreference: "unchanged",
    helping: true,
  },
  action: "none",
};
async function fixture() {
  const s = createSession(crypto.randomUUID());
  await store.saveSession(s);
  return s;
}

test("40 simultaneous repeated clicks produce exactly one model turn and one rate slot", async () => {
  const s = await fixture();
  let calls = 0;
  const respond = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { turn };
  };
  const results = await Promise.all(
    Array.from({ length: 40 }, () =>
      chat.processChat(
        s.id,
        { id: "repeated-request", text: "Interview please" },
        respond,
      ),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(results.at(-1)!.messages.length, 3);
  const rate = await store.rawStore.read<{ count: number }>(
    "rate:" + s.id + ":chat",
  );
  assert.equal(rate!.count, 1);
});
test("a provider failure can retry the saved message without duplicating it or allowing changed payloads", async () => {
  const s = await fixture();
  await assert.rejects(
    chat.processChat(
      s.id,
      { id: "retry-me", text: "Help me practice" },
      async () => {
        throw new Error("provider unavailable");
      },
    ),
  );
  assert.equal((await store.getSession(s.id))!.messages.length, 2);
  await assert.rejects(
    chat.processChat(
      s.id,
      { id: "retry-me", text: "Altered content" },
      async () => {
        throw new Error("must not call provider");
      },
    ),
    /message changed/,
  );
  const done = await chat.processChat(
    s.id,
    { id: "retry-me", text: "Help me practice" },
    async () => ({ turn }),
  );
  assert.equal(done.messages.length, 3);
});
test("a completed call resumes once even when unrelated events arrive later", async () => {
  const s = await fixture();
  endCall(s, "ended");
  addMessage(s, {
    id: "gmail:event",
    role: "event",
    channel: "system",
    text: "Gmail deferred",
    at: Date.now(),
  });
  await store.saveSession(s);
  let calls = 0;
  const respond = async () => {
    calls++;
    return { turn };
  };
  await Promise.all([
    chat.processChat(s.id, { id: "resume-one", resume: true }, respond),
    chat.processChat(s.id, { id: "resume-two", resume: true }, respond),
  ]);
  assert.equal(calls, 1);
  assert.ok(
    (await store.getSession(s.id))!.processed.some((id) =>
      id.startsWith("resume:call-event:"),
    ),
  );
});
test("late automatic resume cannot add an unsolicited reply after typed continuation", async () => {
  const s = await fixture();
  endCall(s, "ended");
  await store.saveSession(s);
  await chat.processChat(
    s.id,
    { id: "typed-first", text: "Keep going here" },
    async () => ({ turn }),
  );
  await chat.processChat(
    s.id,
    { id: "late-resume", resume: true },
    async () => {
      throw new Error("late resume must not call model");
    },
  );
  assert.equal((await store.getSession(s.id))!.messages.length, 4);
});
test("demo call caps resume once without a provider call, repeated intake, or changed memory", async () => {
  for (const reason of ["Call ended · demo token budget"]) {
    const s = await fixture();
    s.profile.userName = { status: "known", value: "Riley" };
    s.profile.goal = {
      status: "known",
      value: "Practice my interview introduction",
    };
    s.gmail.status = "declined";
    s.call = { status: "active", attempts: 1, id: "call", preference: "open" };
    s.helping = true;
    addMessage(s, {
      id: "voice-latest",
      role: "user",
      channel: "voice",
      at: Date.now(),
      text: "Keep the introduction short and focus on my design work.",
    });
    endCall(s, "ended", reason);
    const profile = structuredClone(s.profile);
    const messages = structuredClone(s.messages);
    await store.saveSession(s);
    const respond = async (): Promise<{ turn: AgentTurn }> => {
      throw new Error("a demo limit acknowledgment must not call the model");
    };
    await Promise.all([
      chat.processChat(s.id, { id: "cap-resume-one", resume: true }, respond),
      chat.processChat(s.id, { id: "cap-resume-two", resume: true }, respond),
    ]);
    const saved = (await store.getSession(s.id))!;
    assert.equal(saved.messages.length, messages.length + 1);
    assert.deepEqual(saved.messages.slice(0, -1), messages);
    assert.equal(
      saved.messages.at(-1)!.text,
      "This demo has reached its available token spending limit for voice. Your conversation is saved.",
    );
    assert.deepEqual(saved.profile, profile);
    assert.equal(saved.helping, true);
    assert.equal(saved.gmail.status, "declined");
    assert.equal(saved.call.status, "ended");
    assert.equal(saved.call.preference, "open");
    // This domain fixture has no real provider. Model its completed shutdown
    // before exercising the independently billed typed follow-up.
    await store.rawStore.write("voice-usage:call", { sessionId: s.id, callId: "call", finalized: true, settledCents: 0 });
    await chat.processChat(
      s.id,
      { id: "continue-topic", text: "Make that opening less formal." },
      async (current) => {
        assert.deepEqual(current.profile, profile);
        assert.ok(current.messages.some((m) => m.id === "voice-latest"));
        return { turn };
      },
    );
  }
});
test("active calls reject chat; reserved IDs and ambiguous envelopes are rejected", async () => {
  const s = await fixture();
  s.call.status = "active";
  await store.saveSession(s);
  await assert.rejects(
    chat.processChat(s.id, { id: "during-call", text: "Hello" }, async () => ({
      turn,
    })),
    /End the call/,
  );
  s.call.status = "ended";
  await store.saveSession(s);
  await assert.rejects(
    chat.processChat(
      s.id,
      { id: "welcome", text: "Hijack welcome" },
      async () => ({ turn }),
    ),
    /message changed/,
  );
  for (const body of [
    { id: "sample-id" },
    { id: "sample-id", text: " " },
    { id: "sample-id", resume: true, text: "both" },
    { id: "sample-id", text: "x".repeat(2001) },
  ])
    assert.equal(chat.chatSchema.safeParse(body).success, false);
});
test("a long conversation keeps accepting new turns after rolling history with its saved identity intact", async () => {
  const s = await fixture();
  s.profile.userName = { status: "known", value: "Riley" };
  for (let i = 0; i < 500; i++)
    addMessage(s, {
      id: "old-" + i,
      role: i % 2 ? "assistant" : "user",
      channel: "text",
      text: "Long dialogue " + i,
      at: i,
    });
  s.processed.push("old-completed");
  await store.saveSession(s);
  const result = await chat.processChat(
    s.id,
    { id: "newest-turn", text: "What should we practice next?" },
    async (current) => {
      assert.equal(current.profile.userName.value, "Riley");
      return { turn };
    },
  );
  assert.ok(result.messages.length <= 240);
  assert.ok(result.historyTrimmed! > 0);
  assert.equal(result.messages.at(-1)?.id, "reply:newest-turn");
  await chat.processChat(
    s.id,
    { id: "old-completed", text: "Old request replay" },
    async () => {
      throw new Error("must not replay pruned turn");
    },
  );
});

test("reset waits for an in-flight handshake, stops that call outside the lock, and blocks old-session chat", async () => {
  const s = await fixture();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const handshake = store.mutateSession(s.id, async (current) => {
    started();
    await waiting;
    current.call = { status: "active", id: "late-call", attempts: 1 };
  });
  await entered;
  const calls: string[] = [];
  const reset = retireConversation(s.id, async (callId) => {
    calls.push(callId);
    // A supervisor must be able to take the same lock to save its final words.
    await store.mutateSession(s.id, (current) =>
      addMessage(current, {
        id: "final-voice",
        role: "assistant",
        channel: "voice",
        text: "Talk soon.",
        at: Date.now(),
      }),
    );
    return true;
  });
  release();
  await Promise.all([handshake, reset]);
  assert.deepEqual(calls, ["late-call"]);
  const retired = (await store.getSession(s.id))!;
  assert.ok(retired.retiredAt);
  assert.equal(retired.call.status, "ended");
  assert.equal(retired.messages.at(-1)?.id, "final-voice");
  await assert.rejects(
    chat.processChat(
      s.id,
      { id: "old-session", text: "Late send" },
      async () => {
        throw new Error("must not call provider");
      },
    ),
    /restarted/,
  );
  await retireConversation(s.id, async () => {
    throw new Error("must not hang up twice");
  });
});

test("an old failed send cannot generate a reply to a newer message under the wrong request ID", async () => {
  const s = await fixture();
  await assert.rejects(
    chat.processChat(
      s.id,
      { id: "failed-older", text: "Question A" },
      async () => {
        throw new Error("transient");
      },
    ),
  );
  await chat.processChat(
    s.id,
    { id: "newer-message", text: "Question B" },
    async () => ({ turn }),
  );
  await assert.rejects(
    chat.processChat(
      s.id,
      { id: "failed-older", text: "Question A" },
      async () => {
        throw new Error("must not answer B again");
      },
    ),
    { name: "Error", message: /newer message/ },
  );
  assert.equal(
    (await store.getSession(s.id))!.messages.filter(
      (m) => m.role === "assistant",
    ).length,
    2,
  );
});

test("provider cleanup failure cannot strand reset on a retired cookie", async () => {
  const s = await fixture();
  s.call = { id: "unavailable-call", status: "active", attempts: 1 };
  await store.saveSession(s);
  await retireConversation(s.id, async () => {
    throw new Error("provider unavailable");
  });
  assert.ok((await store.getSession(s.id))!.retiredAt);
  // Successful return allows the route to rotate the cookie and create a new identity.
  const fresh = await fixture();
  assert.notEqual(fresh.id, s.id);
  assert.equal(fresh.retiredAt, undefined);
});
