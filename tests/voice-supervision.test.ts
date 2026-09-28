import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { VoiceEvent } from "../src/lib/voice-events";
import { realtimeConfiguration } from "../src/lib/voice-config";
import { contextMessages } from "../src/lib/prompt";
import {
  VOICE_RESERVATION_CENTS,
  VOICE_USAGE_LIMIT_CENTS,
  VOICE_SHUTDOWN_HEADROOM_CENTS,
} from "../src/lib/voice-limits";
const originalCwd = process.cwd();
let directory = "";
let realtime: typeof import("../src/lib/realtime");
let store: typeof import("../src/lib/store");
let domain: typeof import("../src/lib/domain");
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "persona-voice-supervision-"));
  process.chdir(directory);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL;
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  process.env.DEMO_BUDGET_USD = "5";
  realtime = await import("../src/lib/realtime");
  store = await import("../src/lib/store");
  domain = await import("../src/lib/domain");
});
after(async () => {
  process.chdir(originalCwd);
  await rm(directory, { recursive: true, force: true });
});
const tick = () => new Promise<void>((r) => setImmediate(r));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closes = 0;
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.closes++;
    this.readyState = WebSocket.CLOSING;
  }
  terminate() {
    this.disconnect(1006);
  }
  disconnect(code: number) {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code);
  }
  message(event: VoiceEvent) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
}
function response(id: string, input = 100): VoiceEvent {
  return {
    type: "response.done",
    response: {
      id,
      status: "completed",
      usage: {
        input_tokens: input,
        output_tokens: 0,
        input_token_details: {
          text_tokens: input,
          audio_tokens: 0,
          cached_tokens: 0,
        },
        output_token_details: { text_tokens: 0, audio_tokens: 0 },
      },
    },
  };
}
async function setup(id: string, consumeInitialConfiguration = true) {
  const session = domain.createSession(id);
  session.call = {
    ...session.call,
    id,
    status: "active",
    startedAt: Date.now(),
  };
  await store.saveSession(session);
  const configuration = realtimeConfiguration(
    session,
    "gpt-realtime-2.1",
    false,
  );
  const socket = new Socket();
  const supervisor = realtime.superviseCall(
    id,
    id,
    { reservation: id, model: "gpt-realtime-2.1", configuration },
    socket as unknown as WebSocket,
  );
  socket.emit("open");
  await supervisor.ready;
  if (consumeInitialConfiguration) {
    const { model: _model, ...expected } = configuration;
    assert.deepEqual(
      socket.sent.map((value) => JSON.parse(value)),
      [{ type: "session.update", session: expected }],
    );
    socket.sent.length = 0;
  }
  return { socket, supervisor, configuration };
}
async function blockSession(id: string) {
  const blocked = deferred(),
    entered = deferred();
  const task = store.exclusive("session:" + id, () => {
    entered.resolve();
    return blocked.promise;
  });
  await entered.promise;
  return { release: blocked.resolve, task };
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Expected queued voice event did not finish");
}
test("opening the sideband reapplies exact configuration without waiting for browser-only session events", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  t.mock.method(console, "info", () => {});
  const { socket, supervisor, configuration } = await setup(
    "configuration-gate",
    false,
  );
  await supervisor.ready;
  const { model: _model, ...expectedUpdate } = configuration;
  assert.deepEqual(
    socket.sent.map((value) => JSON.parse(value)),
    [{ type: "session.update", session: expectedUpdate }],
  );
  assert.equal(
    supervisor.ready,
    supervisor.connected,
    "SDP can return before WebRTC begins receiving lifecycle events",
  );
  socket.emit("open");
  assert.equal(
    socket.sent.length,
    1,
    "configuration is reapplied once per sideband connection",
  );
  assert.ok(
    socket.sent.every((value) => JSON.parse(value).type !== "response.create"),
    "only the verified browser starts speech",
  );
  await supervisor.abort();
  socket.disconnect(1006);
  await supervisor.done;
});
test("startup abort keeps an unknown-usage hold while complete authenticated zero usage can settle", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  for (const completeUsage of [false, true]) {
    const id = "startup-abort-" + completeUsage;
    const { socket, supervisor } = await setup(id, false);
    if (completeUsage) {
      socket.message({ type: "response.created", response: { id: "zero" } });
      socket.message(response("zero", 0));
    }
    await supervisor.abort();
    socket.disconnect(1006);
    await supervisor.done;
    const receipt = (await store.rawStore.read<{
      contextVerification: string;
      providerAcknowledgedHangup: boolean;
      terminationStartedBeforeClose: boolean;
      settledCents: number | null;
      finalized: boolean;
    }>("voice-usage:" + id))!;
    assert.match(receipt.contextVerification, /WebRTC peer checks exact/);
    assert.equal(receipt.providerAcknowledgedHangup, true);
    assert.equal(receipt.terminationStartedBeforeClose, true);
    assert.equal(receipt.finalized, true);
    assert.equal(receipt.settledCents, completeUsage ? 0 : null);
    assert.ok(
      socket.sent.every(
        (message) => JSON.parse(message).type !== "response.create",
      ),
    );
  }
  assert.equal(hangups, 2);
});

test("remember corrections and forgetting update durable instructions before the model continues", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  t.mock.method(console, "info", () => {});
  const { socket, supervisor } = await setup("durable-voice-memory");
  const patches = [
    { status: "known", value: "Riley" },
    { status: "known", value: "Sam" },
    { status: "declined", value: null },
  ];
  for (const [index, userName] of patches.entries()) {
    const id = "remember-" + index;
    const start = socket.sent.length;
    socket.message({ type: "response.created", response: { id } });
    socket.message({
      type: "response.function_call_arguments.done",
      response_id: id,
      call_id: id,
      name: "remember",
      arguments: JSON.stringify({
        agentName: null,
        userName,
        goal: null,
        callPreference: "unchanged",
        gmailPreference: "unchanged",
        helping: false,
      }),
    });
    socket.message(response(id));
    await until(() =>
      socket.sent
        .slice(start)
        .some((message) => JSON.parse(message).type === "response.create"),
    );
    const saved = (await store.getSession("durable-voice-memory"))!;
    assert.deepEqual(saved.profile.userName, userName);
    const events = socket.sent
      .slice(start)
      .map((message) => JSON.parse(message));
    const update = events.find((event) => event.type === "session.update");
    const expected = realtimeConfiguration(
      saved,
      "gpt-realtime-2.1",
      false,
      "memory",
    );
    assert.deepEqual(update.session, {
      type: "realtime",
      instructions: expected.instructions,
    });
    assert.match(
      update.session.instructions,
      /SAVED FACTS UPDATED DURING THIS TURN/,
    );
    assert.ok(
      events.indexOf(update) <
        events.findIndex((event) => event.type === "conversation.item.create"),
      "updated facts precede tool result and continuation",
    );

    assert.equal(
      socket.closes,
      0,
      "durable-memory updates keep the sideband connected",
    );
  }
  await supervisor.abort();
  socket.disconnect(1006);
  await supervisor.done;
});

test("failed memory persistence cannot publish new facts into provider instructions", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  t.mock.method(console, "info", () => {});
  const { socket, supervisor } = await setup("failed-voice-memory");
  const file = join(
    directory,
    ".data",
    encodeURIComponent("session:failed-voice-memory") + ".json",
  );
  await rename(file, file + ".backup");
  await mkdir(file);
  try {
    socket.message({
      type: "response.created",
      response: { id: "failed-memory" },
    });
    socket.message({
      type: "response.function_call_arguments.done",
      response_id: "failed-memory",
      call_id: "failed-memory",
      name: "remember",
      arguments: JSON.stringify({
        agentName: null,
        userName: { status: "known", value: "Unsaved" },
        goal: null,
        callPreference: "unchanged",
        gmailPreference: "unchanged",
        helping: false,
      }),
    });
    socket.message(response("failed-memory"));
    await until(() =>
      socket.sent.some(
        (message) => JSON.parse(message).type === "conversation.item.create",
      ),
    );
    assert.ok(
      socket.sent.every(
        (message) => JSON.parse(message).type !== "session.update",
      ),
    );
    const output = JSON.parse(
      socket.sent.find(
        (message) => JSON.parse(message).type === "conversation.item.create",
      )!,
    );
    assert.equal(JSON.parse(output.item.output).success, false);
  } finally {
    await rm(file, { recursive: true });
    await rename(file + ".backup", file);
    await supervisor.abort();
    socket.disconnect(1006);
    await supervisor.done;
  }
  assert.equal(
    (await store.getSession("failed-voice-memory"))!.profile.userName.value,
    null,
  );
});
test("unexpected sideband loss stops provider immediately despite a blocked session save", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  const { socket, supervisor } = await setup("lost-sideband");
  const block = await blockSession("lost-sideband");
  socket.message({ type: "input_audio_buffer.committed", item_id: "late" });
  socket.message({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "late",
    transcript: "Final words",
    usage: {
      type: "tokens",
      input_tokens: 1,
      output_tokens: 1,
      input_token_details: { text_tokens: 0, audio_tokens: 1 },
    },
  });
  await tick();
  socket.disconnect(1006);
  assert.equal(
    hangups,
    1,
    "hangup must start before the session lock is released",
  );
  block.release();
  await block.task;
  await supervisor.done;
  assert.ok(
    (await store.getSession("lost-sideband"))!.messages.some(
      (m) => m.text === "Final words",
    ),
  );
  const receipt = await store.rawStore.read<{
    terminationStartedBeforeClose: boolean;
    settledCents: number | null;
  }>("voice-usage:lost-sideband");
  assert.equal(receipt!.terminationStartedBeforeClose, false);
  assert.equal(receipt!.settledCents, null);
});
test("missing transport renewal fails safely before hosting expiry despite a blocked queue", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  const session = domain.createSession("long-call");
  session.call.id = "long-call";
  session.call.status = "active";
  await store.saveSession(session);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const configuration = realtimeConfiguration(
    session,
    "gpt-realtime-2.1",
    false,
  );
  const socket = new Socket(),
    supervisor = realtime.superviseCall(
      "long-call",
      "long-call",
      { reservation: "long-call", model: "gpt-realtime-2.1", configuration },
      socket as unknown as WebSocket,
    );
  socket.emit("open");
  await supervisor.ready;
  const block = await blockSession("long-call");
  for (let i = 0; i < 25; i++) {
    const id = "brief-" + i;
    socket.message({ type: "response.created", response: { id } });
    socket.message(response(id, 1));
  }
  t.mock.timers.tick(120000);
  assert.equal(
    hangups,
    0,
    "neither two minutes nor twenty responses ends a healthy call",
  );
  socket.message({ type: "response.created", response: { id: "r" } });
  socket.message(response("r"));
  socket.message({
    type: "response.output_audio_transcript.done",
    item_id: "spoken",
    transcript: "Hello",
  });
  await tick();
  t.mock.timers.tick(630000);
  assert.equal(hangups, 1);
  await tick();
  socket.disconnect(1006);
  block.release();
  await block.task;
  await supervisor.done;
  const receipt = await store.rawStore.read<{
    controlledLimitHangup: boolean;
    settledCents: number | null;
  }>("voice-usage:long-call");
  assert.equal(receipt!.controlledLimitHangup, true);
  assert.equal(receipt!.settledCents, 1);
  t.mock.timers.tick(750000);
  await tick();
  assert.equal(hangups, 1, "closed supervisor must have disposed timers");
  t.mock.timers.reset();
});
test("usage cap is enforced before queued persistence and blocks further provider sends", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  const { socket, supervisor } = await setup("cost-cap");
  const block = await blockSession("cost-cap");
  socket.message({
    type: "response.output_audio_transcript.done",
    item_id: "spoken",
    transcript: "Before the cap",
  });
  await tick();
  socket.message({ type: "response.created", response: { id: "expensive" } });
  socket.message(response("expensive", 250000));
  assert.equal(hangups, 1);
  await tick();
  socket.disconnect(1006);
  block.release();
  await block.task;
  await supervisor.done;
  assert.equal(socket.sent.length, 0);
  const receipt = await store.rawStore.read<{
    reportedDollars: number;
    unknown: boolean;
    settledCents: number | null;
  }>("voice-usage:cost-cap");
  assert.equal(receipt!.reportedDollars, 1);
  assert.equal(receipt!.unknown, false);
  assert.equal(receipt!.settledCents, 100);
});
test("realtime call creation bounds accumulated context with documented retention config", async (t) => {
  const previousModel = process.env.REALTIME_MODEL;
  process.env.REALTIME_MODEL = "gpt-realtime-2.1";
  t.after(() => { if (previousModel === undefined) delete process.env.REALTIME_MODEL; else process.env.REALTIME_MODEL = previousModel; });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const session = JSON.parse(
        String((init.body as FormData).get("session")),
      );
      assert.deepEqual(session.truncation, {
        type: "retention_ratio",
        retention_ratio: 0.8,
        token_limits: { post_instructions: 8000 },
      });
      assert.equal(session.max_output_tokens, 600);
      assert.equal(session.model, "gpt-realtime-2.1");
      return new Response("sdp", {
        status: 200,
        headers: { location: "/v1/realtime/calls/synthetic-call" },
      });
    },
  );
  const created = await realtime.createRealtime(
    domain.createSession("config"),
    "synthetic-sdp",
  );
  assert.equal(created.callId, "synthetic-call");
  const budget = await store.rawStore.read<{
    reservations: Record<string, number>;
  }>("budget");
  assert.equal(budget!.reservations[created.reservation], 500);
  assert.equal(created.reservedCents, 500);
  assert.equal(VOICE_RESERVATION_CENTS, 125);
  assert.equal(
    VOICE_RESERVATION_CENTS - VOICE_USAGE_LIMIT_CENTS,
    VOICE_SHUTDOWN_HEADROOM_CENTS,
  );
  assert.equal(VOICE_SHUTDOWN_HEADROOM_CENTS, 50);
});

test("a controlled cap still retains the full hold when transcription usage is pending", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  t.mock.method(console, "info", () => {});
  const { socket, supervisor } = await setup("pending-at-cap");
  socket.message({
    type: "input_audio_buffer.committed",
    item_id: "not-transcribed",
  });
  socket.message({ type: "response.created", response: { id: "expensive" } });
  socket.message(response("expensive", 250000));
  await tick();
  socket.disconnect(1006);
  await supervisor.done;
  const receipt = await store.rawStore.read<{
    controlledLimitHangup: boolean;
    pendingTranscripts: number;
    settledCents: number | null;
  }>("voice-usage:pending-at-cap");
  assert.equal(receipt!.controlledLimitHangup, true);
  assert.equal(receipt!.pendingTranscripts, 1);
  assert.equal(receipt!.settledCents, null);
});

test("a transient provider hangup failure retries once without duplicate shutdown work", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++attempts === 1) throw new Error("transient network failure");
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  const { socket, supervisor } = await setup("retry-hangup");
  socket.message({ type: "response.created", response: { id: "expensive" } });
  socket.message(response("expensive", 250000));
  await tick();
  socket.disconnect(1006);
  await supervisor.done;
  assert.equal(attempts, 2);
  assert.equal(socket.closes, 1);
  const receipt = await store.rawStore.read<{
    providerAcknowledgedHangup: boolean;
    settledCents: number | null;
  }>("voice-usage:retry-hangup");
  assert.equal(receipt!.providerAcknowledgedHangup, true);
  assert.equal(receipt!.settledCents, 100);
});

test("the stricter 75-cent stop leaves the same 50-cent shutdown headroom", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  const { socket, supervisor } = await setup("stricter-cap");
  for (let i = 0; i < 15; i++) {
    const id = String(i);
    socket.message({ type: "response.created", response: { id } });
    socket.message(response(id, i === 14 ? 12499 : 12500));
  }
  assert.equal(hangups, 0, "the known subtotal is still $0.749996");
  socket.message({ type: "response.created", response: { id: "threshold" } });
  socket.message(response("threshold", 1));
  assert.equal(hangups, 1, "one more 4-microdollar token reaches $0.75");
  await tick();
  socket.disconnect(1006);
  await supervisor.done;
  const receipt = await store.rawStore.read<{
    reportedDollars: number;
    settledCents: number | null;
  }>("voice-usage:stricter-cap");
  assert.equal(receipt!.reportedDollars, 0.75);
  assert.equal(receipt!.settledCents, 75);
});

test("active supervisor syncs popup Gmail changes on its existing poll without starting speech", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  t.mock.method(console, "info", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { socket, supervisor } = await setup("gmail-sync");
  const session = (await store.getSession("gmail-sync"))!;
  session.gmail.status = "offered";
  const originalRead = store.rawStore.read;
  t.mock.method(store.rawStore, "read", async (key: string) => {
    if (key === "session:gmail-sync") return session;
    if (key === "voice-stop:gmail-sync") return null;
    return originalRead(key);
  });
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(socket.sent.length, 1);
  session.gmail.status = "connected";
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(socket.sent.length, 2);
  assert.match(
    JSON.parse(socket.sent[1]).item.content[0].text,
    /"status":"connected"/,
  );
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(socket.sent.length, 2, "unchanged state is not repeated");
  assert.ok(
    socket.sent.every(
      (event) => JSON.parse(event).type === "conversation.item.create",
    ),
  );
  socket.disconnect(1006);
  await supervisor.done;
  session.gmail.status = "deferred";
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(socket.sent.length, 2, "closed calls receive no updates");
  t.mock.timers.reset();
});

test("manual hangup drains cancelled response and transcription usage before provider close and settlement", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  // Advance the supervisor poll deterministically, leaving the short drain
  // delays on the real clock so provider events can arrive between checks.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const id = "manual-hangup-drain";
  const { socket, supervisor } = await setup(id);
  try {
    socket.message({ type: "response.created", response: { id: "in-flight" } });
    socket.message({
      type: "output_audio_buffer.started",
      response_id: "in-flight",
    });
    socket.message({
      type: "input_audio_buffer.committed",
      item_id: "final-user-turn",
    });
    await store.rawStore.write("voice-stop:" + id, {
      sessionId: id,
      callId: id,
      status: "requested",
    });
    t.mock.timers.tick(1000);
    await until(() =>
      socket.sent.some(
        (message) => JSON.parse(message).type === "response.cancel",
      ),
    );
    const sent = socket.sent.map((message) => JSON.parse(message));
    assert.ok(sent.some((event) => event.type === "output_audio_buffer.clear"));
    assert.ok(
      sent.every((event) => event.type !== "input_audio_buffer.commit"),
      "already-committed audio must not be committed twice",
    );
    assert.equal(
      hangups,
      0,
      "provider must remain observable while usage is pending",
    );
    assert.equal(socket.closes, 0);
    const cancelled = response("in-flight");
    cancelled.response!.status = "cancelled";
    socket.message(cancelled);
    await tick();
    assert.equal(
      hangups,
      0,
      "pending transcription also prevents premature hangup",
    );
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "final-user-turn",
      transcript: "Call me Riley instead.",
      usage: {
        type: "tokens",
        input_tokens: 1,
        output_tokens: 1,
        input_token_details: { text_tokens: 0, audio_tokens: 1 },
      },
    });
    await until(() => hangups === 1);
    socket.disconnect(1006);
    await supervisor.done;
    assert.ok(
      socket.sent.every(
        (message) => JSON.parse(message).type !== "response.create",
      ),
      "draining cannot start another paid response",
    );
    const receipt = (await store.rawStore.read<{
      manualStopHangup: boolean;
      providerAcknowledgedHangup: boolean;
      pendingResponses: number;
      pendingTranscripts: number;
      settledCents: number | null;
    }>("voice-usage:" + id))!;
    assert.equal(receipt.manualStopHangup, true);
    assert.equal(receipt.providerAcknowledgedHangup, true);
    assert.equal(receipt.pendingResponses, 0);
    assert.equal(receipt.pendingTranscripts, 0);
    assert.equal(
      receipt.settledCents,
      1,
      "complete authenticated usage releases the oversized reservation",
    );
    assert.ok(
      (await store.getSession(id))!.messages.some(
        (message) => message.text === "Call me Riley instead.",
      ),
    );
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      await supervisor.abort();
      socket.disconnect(1006);
    }
    await supervisor.done;
    t.mock.timers.reset();
  }
});

test("manual hangup commits observed final speech and retains its delayed transcript beyond profile facts", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  t.mock.timers.enable({ apis: ["setInterval"] });
  const id = "manual-uncommitted-speech";
  const { socket, supervisor } = await setup(id);
  try {
    socket.message({ type: "response.created", response: { id: "earlier" } });
    socket.message(response("earlier"));
    socket.message({
      type: "input_audio_buffer.speech_started",
      item_id: "vad-predicted-id",
    });
    // This is the route's state transition; final authenticated transcript
    // persistence must still work once the call is marked ended.
    await store.mutateSession(id, (s) =>
      domain.endCall(s, "ended", "Audio call ended"),
    );
    await store.rawStore.write("voice-stop:" + id, {
      sessionId: id,
      callId: id,
      status: "requested",
    });
    t.mock.timers.tick(1000);
    await until(() =>
      socket.sent.some(
        (message) => JSON.parse(message).type === "input_audio_buffer.commit",
      ),
    );
    assert.equal(
      hangups,
      0,
      "uncommitted speech is not equivalent to an empty pending-ASR queue",
    );
    // A manual commit can receive a different item ID from the VAD prediction.
    socket.message({
      type: "input_audio_buffer.committed",
      item_id: "actual-final-utterance",
    });
    socket.message({ type: "response.created", response: { id: "vad-race" } });
    assert.ok(
      socket.sent.some(
        (message) => JSON.parse(message).type === "response.cancel",
      ),
      "a racing automatic answer is cancelled during hangup",
    );
    const cancelled = response("vad-race");
    cancelled.response!.status = "cancelled";
    socket.message(cancelled);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      hangups,
      0,
      "provider must remain open for the final transcript",
    );
    const tangent =
      "One more thing: the spare keys are in the blue kitchen drawer.";
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "actual-final-utterance",
      transcript: tangent,
      usage: {
        type: "tokens",
        input_tokens: 1,
        output_tokens: 1,
        input_token_details: { text_tokens: 0, audio_tokens: 1 },
      },
    });
    await until(() => hangups === 1);
    socket.disconnect(1006);
    await supervisor.done;
    const saved = (await store.getSession(id))!;
    assert.equal(saved.call.status, "ended");
    assert.equal(
      saved.profile.goal.status,
      "unknown",
      "the test does not rely on a remember tool patch",
    );
    assert.ok(
      contextMessages(saved).some(
        (message) => message.role === "user" && message.content === tangent,
      ),
    );
    const types = socket.sent.map((message) => JSON.parse(message).type);
    assert.equal(
      types.filter((type) => type === "input_audio_buffer.commit").length,
      1,
    );
    assert.ok(!types.includes("response.create"));
    const receipt = (await store.rawStore.read<{
      pendingTranscripts: number;
      settledCents: number | null;
      errored: boolean;
    }>("voice-usage:" + id))!;
    assert.equal(receipt.pendingTranscripts, 0);
    assert.equal(receipt.errored, false);
    assert.equal(receipt.settledCents, 1);
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      await supervisor.abort();
      socket.disconnect(1006);
    }
    await supervisor.done;
  }
});

test("unacknowledged final speech flush is bounded and cannot release an unproven voice hold", async (t) => {
  let hangups = 0;
  t.mock.method(globalThis, "fetch", async () => {
    hangups++;
    return new Response(null, { status: 200 });
  });
  t.mock.method(console, "info", () => {});
  t.mock.timers.enable({ apis: ["setInterval"] });
  const id = "manual-unacknowledged-commit";
  const { socket, supervisor } = await setup(id);
  try {
    socket.message({ type: "response.created", response: { id: "earlier" } });
    socket.message(response("earlier"));
    socket.message({
      type: "input_audio_buffer.speech_started",
      item_id: "unfinished",
    });
    await store.rawStore.write("voice-stop:" + id, {
      sessionId: id,
      callId: id,
      status: "requested",
    });
    const started = Date.now();
    t.mock.timers.tick(1000);
    await until(() =>
      socket.sent.some(
        (message) => JSON.parse(message).type === "input_audio_buffer.commit",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 3100));
    assert.equal(hangups, 1);
    assert.ok(
      Date.now() - started < 4500,
      "drain stays within the endpoint's five-second stop coordination window",
    );
    socket.disconnect(1006);
    await supervisor.done;
    const receipt = (await store.rawStore.read<{
      errored: boolean;
      settledCents: number | null;
    }>("voice-usage:" + id))!;
    assert.equal(receipt.errored, true);
    assert.equal(
      receipt.settledCents,
      null,
      "a missing commit receipt must retain the original reservation",
    );
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      await supervisor.abort();
      socket.disconnect(1006);
    }
    await supervisor.done;
  }
});
