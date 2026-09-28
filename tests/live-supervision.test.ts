import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { liveConfiguration } from "../src/lib/live-config";
import { contextMessages } from "../src/lib/prompt";
import type { AgentTurn } from "../src/lib/domain";
import type { generateLiveTurn } from "../src/lib/live-backend";

const originalCwd = process.cwd();
let directory: string;
let live: typeof import("../src/lib/live");
let store: typeof import("../src/lib/store");
let domain: typeof import("../src/lib/domain");
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "persona-live-supervision-"));
  process.chdir(directory);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL;
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  process.env.DEMO_BUDGET_USD = "5";
  live = await import("../src/lib/live");
  store = await import("../src/lib/store");
  domain = await import("../src/lib/domain");
});
after(async () => {
  process.chdir(originalCwd);
  await rm(directory, { recursive: true, force: true });
});
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = WebSocket.CLOSING;
    queueMicrotask(() => this.disconnect());
  }
  terminate() {
    this.disconnect();
  }
  disconnect() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006);
  }
  message(event: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const turn = (name?: string): AgentTurn => ({
  reply: name ? `Got it, ${name}.` : "We can continue in messages.",
  memory: {
    agentName: null,
    userName: name ? { status: "known", value: name } : null,
    goal: null,
    callPreference: "unchanged",
    gmailPreference: "unchanged",
    helping: false,
  },
  action: "none",
});
async function setup(id: string, backend?: typeof generateLiveTurn) {
  const session = domain.createSession(id);
  session.call = { id, status: "active", attempts: 1 };
  await store.saveSession(session);
  await store.rawStore.write("budget", {
    cents: 200,
    reservations: { historical: 50, [id]: 100 },
  });
  const socket = new Socket();
  const supervisor = live.superviseLiveCall(
    id,
    id,
    {
      reservation: id,
      reservedCents: 100,
      model: "gpt-live-1",
      configuration: liveConfiguration(session, false),
    },
    socket as unknown as WebSocket,
    backend ??
      (async (_s, bill) => {
        bill(0);
        return { turn: turn(), endCall: false };
      }),
  );
  socket.emit("open");
  await supervisor.ready;
  socket.message({
    type: "session.started",
    session: { id, model: "gpt-live-1" },
  });
  return { socket, supervisor };
}
const closed = (id: string, seconds = 60) => ({
  type: "session.closed",
  session: { id, model: "gpt-live-1" },
  reason: "close_requested",
  usage: { seconds },
});
const transcript = (
  id: string,
  delta: string,
  start: number,
  role = "input",
) => ({
  type: `session.${role}_transcript.delta`,
  event_id: id,
  delta,
  start_ms: start,
  end_ms: start + 100,
});
const delegation = (id: string) => ({
  type: "session.delegation.created",
  delegation: { id, target: "client" },
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Live lifecycle did not reach expected state");
}
type Receipt = {
  finalized: boolean;
  settledCents: number | null;
  reportedDollars: number;
  finalConfirmed: boolean;
  backendCalls: number;
  pendingBackendCalls: number;
};

test("graceful close retains final transcript fragments and tangents in timestamp order without profile memory", async () => {
  const id = "live-final-transcript";
  const { socket, supervisor } = await setup(id);
  const stopping = supervisor.abort();
  assert.equal(socket.sent.filter((e) => e.type === "session.close").length, 1);
  socket.message(transcript("later", "blue drawer.", 200));
  socket.message(transcript("earlier", "The spare key is in the ", 100));
  socket.message(transcript("later", "blue drawer.", 200));
  socket.message(transcript("assistant", "Got it.", 400, "output"));
  socket.message(transcript("correction", "Actually, the green drawer.", 600));
  socket.message(closed(id));
  assert.equal(await stopping, true);
  await supervisor.done;
  const saved = (await store.getSession(id))!;
  const history = saved.messages.filter((m) => m.channel === "voice");
  assert.deepEqual(
    history.map((m) => [m.role, m.text]),
    [
      ["user", "The spare key is in the blue drawer."],
      ["assistant", "Got it."],
      ["user", "Actually, the green drawer."],
    ],
  );
  assert.equal(saved.profile.goal.status, "unknown");
  assert.ok(
    contextMessages(saved).some(
      (m) => m.content === "Actually, the green drawer.",
    ),
  );
  assert.equal(saved.call.status, "ended");
  const receipt = (await store.rawStore.read<Receipt>("voice-usage:" + id))!;
  assert.equal(receipt.settledCents, 5);
  assert.equal(receipt.finalConfirmed, true);
  assert.deepEqual(await store.rawStore.read("budget"), {
    cents: 105,
    reservations: { historical: 50 },
  });
});

test("transport loss saves observed speech but missing final usage retains the full reservation", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  const id = "live-missing-final";
  const { socket, supervisor } = await setup(id);
  socket.message(
    transcript("last", "Keep the meeting example for later.", 100),
  );
  socket.message({ type: "session.usage.updated", usage: { seconds: 20 } });
  socket.disconnect();
  await supervisor.done;
  assert.equal(hangups, 1);
  assert.ok(
    (await store.getSession(id))!.messages.some(
      (m) => m.text === "Keep the meeting example for later.",
    ),
  );
  assert.equal(
    (await store.rawStore.read<Receipt>("voice-usage:" + id))!.settledCents,
    null,
  );
  assert.deepEqual(await store.rawStore.read("budget"), {
    cents: 200,
    reservations: { historical: 50, [id]: 100 },
  });
});

test("a closed event for another provider session is not successful finalization", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  const id = "live-wrong-final";
  const { socket, supervisor } = await setup(id);
  socket.message(closed("different-provider-id"));
  await supervisor.done;
  const receipt = (await store.rawStore.read<Receipt>("voice-usage:" + id))!;
  assert.equal(receipt.finalConfirmed, false);
  assert.equal(receipt.settledCents, null);
});

test("final usage waits for pending backend cost and preserves its completed facts after hangup", async () => {
  const entered = deferred(),
    release = deferred();
  const id = "live-pending-backend";
  const { socket, supervisor } = await setup(id, async (_s, bill) => {
    entered.resolve();
    await release.promise;
    bill(0.02);
    return { turn: turn("Riley"), endCall: false };
  });
  socket.message(transcript("name", "I'm Riley.", 100));
  socket.message(delegation("save-name"));
  await entered.promise;
  socket.message(closed(id, 90));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    await store.rawStore.read("voice-usage:" + id),
    null,
    "cannot publish a refund while backend work is pending",
  );
  release.resolve();
  await supervisor.done;
  const receipt = (await store.rawStore.read<Receipt>("voice-usage:" + id))!;
  assert.equal(receipt.settledCents, 10);
  assert.equal(receipt.reportedDollars, 0.095);
  assert.equal(receipt.pendingBackendCalls, 0);
  assert.equal((await store.getSession(id))!.profile.userName.value, "Riley");
  assert.ok(
    socket.sent.every((e) => e.type !== "session.commentary.append"),
    "a late completed result must not restart speech after close",
  );
});

test("a newer correction retries once and saves the latest facts without another delegation", async (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const id = "live-correction";
  const { socket, supervisor } = await setup(id, async (s, bill) => {
    calls++;
    if (calls === 1) {
      entered.resolve();
      await release.promise;
      bill(0.002);
      return { turn: turn("Mara"), endCall: false };
    }
    assert.ok(
      contextMessages(s).some((m) => m.content.includes("Actually, Riley.")),
    );
    bill(0.003);
    return { turn: turn("Riley"), endCall: false };
  });
  socket.message(transcript("name", "I'm Mara. ", 100));
  socket.message(delegation("save-name"));
  await entered.promise;
  socket.message(transcript("correction", "Actually, Riley.", 300));
  release.resolve();
  await until(() =>
    socket.sent.some((e) => e.type === "session.commentary.append"),
  );
  assert.equal(calls, 2);
  assert.equal((await store.getSession(id))!.profile.userName.value, "Riley");
  assert.ok(
    socket.sent
      .filter((e) => e.type === "session.commentary.append")
      .every((e) => e.content === "Got it, Riley."),
  );
  socket.message(closed(id));
  await supervisor.done;
  const receipt = (await store.rawStore.read<Receipt>("voice-usage:" + id))!;
  assert.equal(receipt.backendCalls, 2);
  assert.equal(receipt.settledCents, 6);
});

test("a late backend and close event cannot mutate or end a replacement call", async () => {
  const entered = deferred(),
    release = deferred();
  const id = "live-replacement";
  const { socket, supervisor } = await setup(id, async (_s, bill) => {
    entered.resolve();
    await release.promise;
    bill(0.001);
    return { turn: turn("Outdated"), endCall: true };
  });
  socket.message(delegation("old-work"));
  await entered.promise;
  await store.mutateSession(id, (s) => {
    s.call.id = "replacement";
    s.call.status = "active";
  });
  release.resolve();
  socket.message(closed(id));
  await supervisor.done;
  const saved = (await store.getSession(id))!;
  assert.equal(saved.call.id, "replacement");
  assert.equal(saved.call.status, "active");
  assert.equal(saved.profile.userName.value, null);
  assert.ok(socket.sent.every((e) => e.type !== "session.commentary.append"));
});

test("unknown delegated usage retains the hold even with a valid final duration", async () => {
  const id = "live-unknown-backend";
  const { socket, supervisor } = await setup(id, async (_s, bill) => {
    bill(undefined);
    return { turn: turn(), endCall: false };
  });
  socket.message(delegation("unknown-cost"));
  await until(() =>
    socket.sent.some((e) => e.type === "session.commentary.append"),
  );
  socket.message(closed(id));
  await supervisor.done;
  assert.equal(
    (await store.rawStore.read<Receipt>("voice-usage:" + id))!.settledCents,
    null,
  );
  assert.deepEqual(await store.rawStore.read("budget"), {
    cents: 200,
    reservations: { historical: 50, [id]: 100 },
  });
});

test("settled user speech saves names quietly without relying on a Live delegation", async () => {
  let calls = 0;
  const id = "live-auto-memory";
  const { socket, supervisor } = await setup(id, async (s, bill) => {
    calls++;
    assert.ok(contextMessages(s).some((m) => m.content === "I'm Mara."));
    bill(0.001);
    return { turn: turn("Mara"), endCall: false };
  });
  socket.message(transcript("name-a", "I'm ", 100));
  socket.message(transcript("name-b", "Mara.", 200));
  await until(() =>
    socket.sent.some((e) => e.type === "session.thinking.append"),
  );
  assert.equal(calls, 1);
  assert.equal((await store.getSession(id))!.profile.userName.value, "Mara");
  assert.ok(
    socket.sent
      .filter((e) => e.type === "session.thinking.append")
      .every((e) => e.delegation_id === null),
  );
  assert.ok(socket.sent.every((e) => e.type !== "session.commentary.append"));
  socket.message(delegation("late-provider-save"));
  await new Promise((resolve) => setTimeout(resolve, 720));
  assert.equal(
    calls,
    1,
    "the provider delegation reuses the already covered transcript revision",
  );
  assert.ok(
    socket.sent.every((e) => e.type !== "session.commentary.append"),
    "reuse must not repeat the natural spoken answer",
  );
  socket.message(closed(id));
  await supervisor.done;
});

test("hangup flushes pending transcript-driven correction before settling with no late speech", async () => {
  let calls = 0;
  const id = "live-final-memory";
  const { socket, supervisor } = await setup(id, async (s, bill) => {
    calls++;
    assert.ok(
      contextMessages(s).some((m) => m.content === "Actually Riley. No Gmail."),
    );
    bill(0.001);
    const result = turn("Riley");
    result.memory.gmailPreference = "declined";
    return { turn: result, endCall: false };
  });
  const stopping = supervisor.abort();
  socket.message(
    transcript("final-correction", "Actually Riley. No Gmail.", 100),
  );
  socket.message(closed(id));
  await stopping;
  await supervisor.done;
  assert.equal(calls, 1);
  const saved = (await store.getSession(id))!;
  assert.equal(saved.profile.userName.value, "Riley");
  assert.equal(saved.gmail.status, "declined");
  assert.ok(socket.sent.every((e) => e.type !== "session.commentary.append"));
  assert.equal(
    (await store.rawStore.read<Receipt>("voice-usage:" + id))!.settledCents,
    6,
  );
});

test("transcript-driven Gmail invitation appears once and does not reopen a refusal", async () => {
  let calls = 0;
  const id = "live-auto-gmail";
  const { socket, supervisor } = await setup(id, async (_s, bill) => {
    calls++;
    bill(0.001);
    const result = turn();
    result.action = "offer_gmail";
    if (calls === 2) result.memory.gmailPreference = "declined";
    return { turn: result, endCall: false };
  });
  socket.message(transcript("goal", "I want interview practice.", 100));
  await until(() =>
    socket.sent.some((e) => e.type === "session.commentary.append"),
  );
  assert.equal((await store.getSession(id))!.gmail.status, "offered");
  socket.message(transcript("skip", "No Gmail.", 2500));
  await until(() => calls === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await store.getSession(id))!.gmail.status, "declined");
  assert.equal(
    socket.sent.filter((e) => e.type === "session.commentary.append").length,
    1,
  );
  socket.message(closed(id));
  await supervisor.done;
});

test("a confirmed Gmail card has actionable speech for provider delegation too", async (t) => {
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
    const previous = process.env[key];
    process.env[key] = "synthetic-test-value";
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const id = "live-gmail-directions";
  const { socket, supervisor } = await setup(id, async (_s, bill) => {
    bill(0);
    const result = turn();
    result.action = "offer_gmail";
    result.reply = "Want to connect it?";
    return { turn: result, endCall: false };
  });
  socket.message(transcript("goal", "Anything else to set up?", 100));
  socket.message(delegation("show-card"));
  await until(() => socket.sent.some((e) => e.type === "session.commentary.append"));
  const spoken = socket.sent.find((e) => e.type === "session.commentary.append")!;
  assert.match(String(spoken.content), /I've put a Gmail connection card in our messages/);
  assert.match(String(spoken.content), /Tap View Gmail connection, then Connect Gmail/);
  assert.doesNotMatch(String(spoken.content), /Want to connect/);
  assert.equal((await store.getSession(id))!.gmail.status, "offered");
  socket.message(closed(id));
  await supervisor.done;
});

test("only fresh verified OAuth events receive one spoken acknowledgment, never voice preference updates", async () => {
  const id = "live-gmail-external-events";
  const { socket, supervisor } = await setup(id);
  const commentaries = () => socket.sent.filter((e) => e.type === "session.commentary.append");
  const event = async (eventId: string, text: string, status: "connected" | "deferred", at = Date.now()) => {
    await store.mutateSession(id, (s) => {
      s.gmail = status === "connected" ? { status, email: "owner@example.test" } : { status };
      domain.addMessage(s, { id: eventId, role: "event", channel: "system", text, at });
    });
  };
  await event("gmail:historical", "Gmail connected · owner@example.test", "connected", Date.now() - 10000);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(commentaries().length, 0, "existing connection is not announced again");
  await store.mutateSession(id, (s) => { s.gmail = { status: "declined" }; });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(commentaries().length, 0, "spoken refusal is not echoed by polling");
  await event("gmail:cancel", "Gmail connection cancelled · continuing the conversation", "deferred");
  await until(() => commentaries().length === 1);
  assert.match(String(commentaries()[0].content), /cancelled/);
  await event("gmail:connected", "Gmail connected · owner@example.test", "connected");
  await until(() => commentaries().length === 2);
  assert.match(String(commentaries()[1].content), /account is connected/);
  await event("gmail-disconnected:now", "Gmail disconnected", "deferred");
  await until(() => commentaries().length === 3);
  assert.match(String(commentaries()[2].content), /Gmail is disconnected/);
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(commentaries().length, 3, "polls do not repeat acknowledgments");
  assert.ok(commentaries().every((e) => !String(e.content).includes("owner@example.test")));
  socket.message(closed(id));
  await supervisor.done;
});

test("provider memory does not repeat Live's answer but an unanswered delegated task still speaks", async () => {
  const entered = deferred(), release = deferred();
  const id = "live-provider-no-echo";
  let calls = 0;
  const { socket, supervisor } = await setup(id, async (_s, bill) => {
    calls++;
    bill(0.001);
    const result = turn("Mara");
    if (calls === 1) {
      entered.resolve();
      await release.promise;
      result.reply = "Nice to meet you, Mara. What's one thing you need help with?";
    } else result.reply = "Lead with the disagreement, your reasoning, and the result.";
    return { turn: result, endCall: false };
  });
  socket.message(transcript("name", "I'm Mara.", 100));
  socket.message(delegation("save-mara"));
  await entered.promise;
  socket.message(transcript("live-answer", "Hi Mara. What's one thing you need help with?", 300, "output"));
  release.resolve();
  await until(() => socket.sent.some((e) => String(e.content).includes("quiet context")));
  assert.equal((await store.getSession(id))!.profile.userName.value, "Mara");
  assert.equal(socket.sent.filter((e) => e.type === "session.commentary.append").length, 0);
  socket.message(transcript("task", "Help me structure an interview answer.", 1000));
  // A delayed older assistant fragment must not suppress the new task's answer.
  socket.message(transcript("old-output-tail", "", 500, "output"));
  socket.message(delegation("interview-answer"));
  await until(() => socket.sent.some((e) => e.type === "session.commentary.append"));
  assert.equal(socket.sent.find((e) => e.type === "session.commentary.append")!.content,
    "Lead with the disagreement, your reasoning, and the result.");
  socket.message(closed(id));
  await supervisor.done;
});
