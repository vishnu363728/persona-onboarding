import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/lib/domain";
import { voiceEventHandler } from "../src/lib/voice-events";
function fixture(
  options: {
    gmailAvailable?: boolean;
    skipSave?: boolean;
    failAfterSave?: boolean;
  } = {},
) {
  const session = createSession("voice-test"),
    sent: unknown[] = [],
    stops: string[] = [];
  const scheduled: {
    work: () => Promise<void>;
    delayMs: number;
    cancelled: boolean;
  }[] = [];
  return {
    session,
    sent,
    stops,
    scheduled,
    handle: voiceEventHandler({
      gmailAvailable: options.gmailAvailable ?? true,
      save: async (fn) => {
        if (options.skipSave) return;
        fn(session);
        if (options.failAfterSave) throw new Error("storage failed");
      },
      send: (e) => sent.push(e),
      schedule: (work, delayMs) => {
        const job = { work, delayMs, cancelled: false };
        scheduled.push(job);
        return () => {
          job.cancelled = true;
        };
      },
      stop: async (reason) => {
        stops.push(reason);
      },
    }),
  };
}
test("voice transcripts deduplicate and truncation works before or after transcript delivery", async () => {
  const f = fixture();
  const event = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "u1",
    transcript: "My name is Sam",
  };
  await f.handle(event);
  await f.handle(event);
  assert.equal(f.session.messages.length, 2);
  await f.handle({ type: "conversation.item.truncated", item_id: "a1" });
  await f.handle({
    type: "response.output_audio_transcript.done",
    item_id: "a1",
    transcript: "A sentence cut off",
  });
  await f.handle({
    type: "response.output_audio_transcript.done",
    item_id: "a2",
    transcript: "Another sentence",
  });
  await f.handle({ type: "conversation.item.truncated", item_id: "a2" });
  assert.ok(f.session.messages.slice(-2).every((m) => m.interrupted));
  assert.ok(
    f.session.messages.slice(-2).every((m) => !m.text.includes("sentence")),
  );
});
test("multiple voice tools save facts and create only one continuation", async () => {
  const f = fixture();
  const args = {
    agentName: null,
    userName: { status: "known", value: "Sam" },
    goal: null,
    callPreference: "unchanged",
    gmailPreference: "unchanged",
    helping: false,
  };
  const remember = {
    type: "response.function_call_arguments.done",
    call_id: "f1",
    name: "remember",
    arguments: JSON.stringify(args),
  };
  await f.handle(remember);
  await f.handle(remember);
  await f.handle({
    type: "response.function_call_arguments.done",
    call_id: "f2",
    name: "offer_gmail",
    arguments: "{}",
  });
  assert.equal(f.session.profile.userName.status, "unknown");
  assert.equal(f.sent.length, 0);
  await f.handle({ type: "response.done", response: { status: "completed" } });
  assert.equal(f.session.profile.userName.value, "Sam");
  assert.equal(f.session.gmail.status, "offered");
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent.at(-1), { type: "response.create" });
});
test("invalid memory tools fail closed, and Gmail refusals are preserved", async () => {
  const f = fixture();
  f.session.gmail.status = "declined";
  await f.handle({
    type: "response.function_call_arguments.done",
    call_id: "f1",
    name: "remember",
    arguments: '{"gmailPreference":"connected"}',
  });
  await f.handle({ type: "response.done", response: { status: "completed" } });
  assert.equal(f.session.gmail.status, "declined");
  assert.match(JSON.stringify(f.sent), /false/);
  await f.handle({
    type: "response.function_call_arguments.done",
    call_id: "f2",
    name: "offer_gmail",
    arguments: "{}",
  });
  assert.equal(f.session.gmail.status, "declined");
});
test("voice budget guard ends once while preserving late final transcription", async () => {
  const f = fixture();
  await f.handle({
    type: "response.done",
    response: { usage: { output_token_details: { audio_tokens: 16000 } } },
  });
  await f.handle({ type: "response.done" });
  assert.equal(f.stops.length, 1);
  await f.handle({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "late",
    transcript: "late input",
  });
  assert.equal(f.session.messages.at(-1)?.text, "late input");
});

test("replayed completed responses count only once toward the voice limit", async () => {
  const f = fixture();
  const e = {
    type: "response.done",
    response: {
      id: "same-response",
      usage: { output_token_details: { audio_tokens: 9000 } },
    },
  };
  await f.handle(e);
  await f.handle(e);
  assert.equal(f.stops.length, 0);
  await f.handle({ ...e, response: { ...e.response, id: "another-response" } });
  assert.equal(f.stops.length, 1);
});

test("cancelled or incomplete function arguments never save memory or restart speech", async () => {
  for (const status of ["cancelled", "incomplete", "failed"]) {
    const f = fixture();
    await f.handle({
      type: "response.function_call_arguments.done",
      response_id: "cancelled",
      call_id: "tool",
      name: "remember",
      arguments: JSON.stringify({
        agentName: null,
        userName: { status: "known", value: "Wrong name" },
        goal: null,
        helping: false,
        callPreference: "unchanged",
        gmailPreference: "unchanged",
      }),
    });
    await f.handle({
      type: "response.done",
      response: { id: "cancelled", status },
    });
    assert.equal(f.session.profile.userName.status, "unknown");
    assert.equal(f.sent.length, 1);
    assert.match(JSON.stringify(f.sent[0]), /false/);
  }
});

test("tools from overlapping responses continue only their own completed turn", async () => {
  const f = fixture();
  await f.handle({
    type: "response.function_call_arguments.done",
    response_id: "a",
    call_id: "f1",
    name: "offer_gmail",
    arguments: "{}",
  });
  await f.handle({
    type: "response.done",
    response: { id: "b", status: "completed" },
  });
  assert.equal(f.sent.length, 0);
  await f.handle({
    type: "response.done",
    response: { id: "a", status: "completed" },
  });
  assert.equal(f.sent.length, 2);
  assert.equal(f.session.gmail.status, "offered");
});

test("spoken hangup ends once without a fresh model response; late transcript is retained", async () => {
  const f = fixture();
  await f.handle({
    type: "response.function_call_arguments.done",
    response_id: "r",
    call_id: "end",
    name: "end_call",
    arguments: "{}",
  });
  assert.equal(f.stops.length, 0);
  await f.handle({
    type: "response.done",
    response: { id: "r", status: "completed" },
  });
  await f.handle({
    type: "response.done",
    response: { id: "r", status: "completed" },
  });
  assert.equal(f.stops.length, 1);
  assert.equal(f.sent.length, 1);
  await f.handle({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "last-user",
    transcript: "Let's switch to text.",
  });
  assert.equal(f.session.messages.at(-1)?.text, "Let's switch to text.");
});

test("interrupted or malformed hangup tool does not terminate the call", async () => {
  for (const [argumentsText, status] of [
    ["{}", "cancelled"],
    ["{", "completed"],
    ['{"force":true}', "completed"],
  ]) {
    const f = fixture();
    await f.handle({
      type: "response.function_call_arguments.done",
      response_id: "r",
      call_id: "end",
      name: "end_call",
      arguments: argumentsText,
    });
    await f.handle({ type: "response.done", response: { id: "r", status } });
    assert.equal(f.stops.length, 0);
  }
});

async function requestSpokenEnd(
  f: ReturnType<typeof fixture>,
  responseId = "goodbye",
) {
  await f.handle({
    type: "response.function_call_arguments.done",
    response_id: responseId,
    call_id: "end-" + responseId,
    name: "end_call",
    arguments: "{}",
  });
  await f.handle({
    type: "response.done",
    response: { id: responseId, status: "completed" },
  });
}

test("spoken hangup waits for its own buffered acknowledgment and suppresses new responses", async () => {
  const f = fixture();
  await f.handle({
    type: "output_audio_buffer.started",
    response_id: "goodbye",
  });
  await requestSpokenEnd(f);
  assert.equal(f.stops.length, 0);
  assert.equal(f.scheduled[0]?.delayMs, 3000);
  await f.handle({
    type: "output_audio_buffer.stopped",
    response_id: "older-response",
  });
  assert.equal(f.stops.length, 0);
  await f.handle({
    type: "response.function_call_arguments.done",
    response_id: "late",
    call_id: "late",
    name: "offer_gmail",
    arguments: "{}",
  });
  await f.handle({
    type: "response.done",
    response: { id: "late", status: "completed" },
  });
  assert.equal(f.sent.length, 1);
  await f.handle({
    type: "output_audio_buffer.stopped",
    response_id: "goodbye",
  });
  assert.equal(f.stops.length, 1);
  assert.equal(f.scheduled[0].cancelled, true);
  // A fallback already queued at the same instant still cannot end twice.
  await f.scheduled[0].work();
  assert.equal(f.stops.length, 1);
});

test("already-drained or tool-only goodbye terminates immediately", async () => {
  for (const drained of [false, true]) {
    const f = fixture();
    if (drained) {
      await f.handle({
        type: "output_audio_buffer.started",
        response_id: "goodbye",
      });
      await f.handle({
        type: "output_audio_buffer.stopped",
        response_id: "goodbye",
      });
    }
    await requestSpokenEnd(f);
    assert.equal(f.stops.length, 1);
    assert.equal(f.scheduled.length, 0);
  }
});

test("missing playback-finished event falls back once and clears its timer", async () => {
  const f = fixture();
  await f.handle({
    type: "output_audio_buffer.started",
    response_id: "goodbye",
  });
  await requestSpokenEnd(f);
  await f.scheduled[0].work();
  assert.equal(f.stops.length, 1);
  assert.equal(f.scheduled[0].cancelled, true);
  await f.handle({
    type: "output_audio_buffer.stopped",
    response_id: "goodbye",
  });
  assert.equal(f.stops.length, 1);
});

test("cleared playback finishes pending hangup; remote shutdown cancels fallback", async () => {
  const f = fixture();
  await f.handle({
    type: "output_audio_buffer.started",
    response_id: "goodbye",
  });
  await requestSpokenEnd(f);
  await f.handle({
    type: "output_audio_buffer.cleared",
    response_id: "goodbye",
  });
  assert.equal(f.stops.length, 1);
  const disconnected = fixture();
  await disconnected.handle({
    type: "output_audio_buffer.started",
    response_id: "goodbye",
  });
  await requestSpokenEnd(disconnected);
  disconnected.handle.dispose();
  assert.equal(disconnected.scheduled[0].cancelled, true);
  await disconnected.scheduled[0].work();
  assert.equal(disconnected.stops.length, 0);
});

test("long voice transcripts retain final corrections before entering saved history", async () => {
  const f = fixture();
  await f.handle({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "long-user",
    transcript:
      "Here is the background. " +
      "🌱 detail ".repeat(5000) +
      " Actually, my name is Riley.",
  });
  await f.handle({
    type: "response.output_audio_transcript.done",
    item_id: "long-assistant",
    transcript:
      "Here is the draft. " +
      "🌱 detail ".repeat(5000) +
      " The final step is to confirm the date.",
  });
  const user = f.session.messages.find(
    (message) => message.id === "long-user",
  )!;
  const assistant = f.session.messages.find(
    (message) => message.id === "long-assistant",
  )!;
  assert.match(user.text, /^Here is the background\./);
  assert.match(user.text, /Actually, my name is Riley\.$/);
  assert.match(assistant.text, /^Here is the draft\./);
  assert.match(assistant.text, /The final step is to confirm the date\.$/);
  for (const message of [user, assistant]) {
    assert.ok(message.text.length <= 12000);
    assert.match(message.text, /Long message shortened/);
    assert.equal(message.text.isWellFormed(), true);
  }
  await f.handle({
    type: "conversation.item.truncated",
    item_id: "long-assistant",
  });
  assert.equal(assistant.text, "[Assistant speech interrupted]");
});

test("standalone voice handler enforces the same 75-cent threshold", async () => {
  const f = fixture();
  for (let i = 0; i < 15; i++) {
    await f.handle({
      type: "response.done",
      response: {
        id: String(i),
        usage: {
          input_token_details: { text_tokens: i === 14 ? 12499 : 12500 },
        },
      },
    });
  }
  assert.equal(f.stops.length, 0);
  await f.handle({
    type: "response.done",
    response: {
      id: "threshold",
      usage: {
        input_token_details: { text_tokens: 1 },
      },
    },
  });
  assert.deepEqual(f.stops, ["Call ended · demo token budget"]);
});

const gmailPatch = (gmailPreference: "open" | "deferred" | "declined") => ({
  agentName: null,
  userName: null,
  goal: null,
  callPreference: "unchanged",
  gmailPreference,
  helping: false,
});
const toolResult = (f: ReturnType<typeof fixture>, callId: string) => {
  const item = f.sent.find(
    (value) =>
      (value as { item?: { call_id?: string } }).item?.call_id === callId,
  ) as { item: { output: string } };
  return JSON.parse(item.item.output);
};
test("same-turn Gmail skip or reopening is respected regardless of tool event order", async () => {
  for (const preference of ["deferred", "declined", "open"] as const) {
    const f = fixture();
    f.session.gmail.status = preference === "open" ? "declined" : "unknown";
    await f.handle({
      type: "response.function_call_arguments.done",
      response_id: "r",
      call_id: "gmail",
      name: "offer_gmail",
      arguments: "{}",
    });
    await f.handle({
      type: "response.function_call_arguments.done",
      response_id: "r",
      call_id: "memory",
      name: "remember",
      arguments: JSON.stringify(gmailPatch(preference)),
    });
    await f.handle({
      type: "response.done",
      response: { id: "r", status: "completed" },
    });
    const offered = preference === "open";
    assert.equal(f.session.gmail.status, offered ? "offered" : preference);
    assert.equal(toolResult(f, "gmail").success, offered);
    assert.equal(toolResult(f, "gmail").cardAvailable, offered);
    assert.equal(toolResult(f, "gmail").gmailStatus, f.session.gmail.status);
    assert.equal(toolResult(f, "memory").success, true);
  }
});
test("Gmail tool distinguishes visible card, unconfigured service, and verified connection", async () => {
  for (const available of [true, false]) {
    const f = fixture({ gmailAvailable: available });
    await f.handle({
      type: "response.function_call_arguments.done",
      call_id: "gmail",
      name: "offer_gmail",
      arguments: "{}",
    });
    await f.handle({
      type: "response.done",
      response: { status: "completed" },
    });
    const result = toolResult(f, "gmail");
    assert.equal(result.cardAvailable, true);
    assert.equal(result.connectionAvailable, available);
    assert.equal(result.reason, available ? "offered" : "service_unavailable");
    assert.equal(result.nextStep.includes("View Gmail connection"), available);
  }
  const connected = fixture();
  connected.session.gmail.status = "connected";
  await connected.handle({
    type: "response.function_call_arguments.done",
    call_id: "gmail",
    name: "offer_gmail",
    arguments: "{}",
  });
  await connected.handle({
    type: "response.done",
    response: { status: "completed" },
  });
  assert.equal(toolResult(connected, "gmail").reason, "already_connected");
  assert.equal(toolResult(connected, "gmail").cardAvailable, false);
});
test("invalid Gmail arguments and skipped or failed storage cannot claim a shown card", async () => {
  for (const args of ["[]", "null", '{"connected":true}']) {
    const f = fixture();
    await f.handle({
      type: "response.function_call_arguments.done",
      call_id: "gmail",
      name: "offer_gmail",
      arguments: args,
    });
    await f.handle({
      type: "response.done",
      response: { status: "completed" },
    });
    assert.equal(f.session.gmail.status, "unknown");
    assert.equal(toolResult(f, "gmail").success, false);
  }
  for (const options of [{ skipSave: true }, { failAfterSave: true }]) {
    const f = fixture(options);
    for (const [callId, name, args] of [
      ["memory", "remember", JSON.stringify(gmailPatch("open"))],
      ["gmail", "offer_gmail", "{}"],
    ])
      await f.handle({
        type: "response.function_call_arguments.done",
        call_id: callId,
        name,
        arguments: args,
      });
    await f.handle({
      type: "response.done",
      response: { status: "completed" },
    });
    assert.equal(toolResult(f, "memory").success, false);
    assert.equal(toolResult(f, "gmail").success, false);
    assert.equal(toolResult(f, "gmail").reason, "memory_not_saved");
    assert.notEqual(toolResult(f, "gmail").cardAvailable, true);
  }
});
test("a rejected same-turn memory patch prevents an out-of-order Gmail offer", async () => {
  const f = fixture();
  for (const [callId, name, args] of [
    ["gmail", "offer_gmail", "{}"],
    ["memory", "remember", '{"gmailPreference":"invalid"}'],
  ])
    await f.handle({
      type: "response.function_call_arguments.done",
      call_id: callId,
      name,
      arguments: args,
    });
  await f.handle({ type: "response.done", response: { status: "completed" } });
  assert.equal(f.session.gmail.status, "unknown");
  assert.equal(toolResult(f, "memory").success, false);
  assert.equal(toolResult(f, "gmail").reason, "memory_not_saved");
  assert.equal(toolResult(f, "gmail").cardAvailable, false);
});
test("end_call arriving first still saves the final preference and does not start a new pitch", async () => {
  const f = fixture();
  for (const [callId, name, args] of [
    ["end", "end_call", "{}"],
    ["gmail", "offer_gmail", "{}"],
    ["memory", "remember", JSON.stringify(gmailPatch("deferred"))],
  ])
    await f.handle({
      type: "response.function_call_arguments.done",
      call_id: callId,
      name,
      arguments: args,
    });
  await f.handle({ type: "response.done", response: { status: "completed" } });
  assert.equal(f.session.gmail.status, "deferred");
  assert.equal(toolResult(f, "gmail").cardAvailable, false);
  assert.equal(toolResult(f, "end").reason, "ending_call");
  assert.equal(f.stops.length, 1);
  assert.ok(
    !f.sent.some(
      (value) => (value as { type: string }).type === "response.create",
    ),
  );
});
