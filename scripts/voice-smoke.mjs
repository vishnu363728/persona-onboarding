/**
 * One real, billable call through the hosted application, using synthetic speech.
 * macOS only (say + afconvert). No API secret is read or sent by this harness.
 * Run: node scripts/voice-smoke.mjs https://persona-onboarding-demo.vercel.app --label=polish
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import wrtc from "@roamhq/wrtc";
import { wavBuffer, normalizeAudio, syntheticSpeech } from "./voice-audio.mjs";

const args = process.argv.slice(2);
const base = (
  args.find((arg) => !arg.startsWith("--")) || "http://127.0.0.1:4317"
).replace(/\/$/, "");
const label = args.find((arg) => arg.startsWith("--label="))?.slice(8);
if (label !== undefined)
  assert.match(
    label,
    /^[a-z0-9][a-z0-9-]{0,31}$/,
    "Use a short lowercase QA label",
  );
const endMode =
  args.find((arg) => arg.startsWith("--end="))?.slice(6) || "spoken";
assert.ok(
  ["spoken", "limit"].includes(endMode),
  "End mode must be spoken or limit",
);
const out = `output/qa/voice${label ? "-" + label : ""}`;
const checks = [],
  events = [],
  samples = [],
  issues = [];
const receivedFormats = new Set();
const started = Date.now();
let cookie = "",
  callId,
  pc,
  sourceTrack,
  sink,
  timer,
  remoteFormat;
let input = new Int16Array(),
  inputOffset = 0,
  remotePeak = 0;
let connectionOpened = false,
  channelClosed = false,
  providerClosure,
  completedEndCall,
  cleanHangup = false,
  finalSession,
  limitClosure;
await mkdir(out, { recursive: true });

async function request(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: base, cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const next = response.headers.get("set-cookie");
  if (next) cookie = next.split(";")[0];
  const data = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
  return data;
}
const speech = (name, text) => syntheticSpeech(out, name, text);
async function until(predicate, label, ms = 20000) {
  const untilAt = Date.now() + ms;
  while (Date.now() < untilAt) {
    if (await predicate()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
function passed(text) {
  checks.push(text);
  console.log("PASS", text);
}
async function play(pcm) {
  input = pcm;
  inputOffset = 0;
  await until(
    () => inputOffset >= input.length,
    "synthetic speech sent",
    pcm.length / 48 + 3000,
  );
}

try {
  const firstSpeech = await speech(
    "user-introduction",
    "My name is Jordan. I have a product design interview tomorrow, and I need help practicing. Please ask me one practice question.",
  );
  const correctionSpeech = await speech(
    "user-correction",
    "Actually, please call me Riley. We can leave Gmail for later. Let's keep practicing for my product design interview.",
  );
  const hangupSpeech = await speech(
    "user-hangup",
    "Please hang up now. Let's continue in messages.",
  );
  const first = await request("/api/session");
  assert.equal(first.capabilities.voice, true);
  const named = await request("/api/chat", {
    id: crypto.randomUUID(),
    text: "I'd like to call you Nova. A quick call sounds good.",
  });
  assert.equal(named.session.profile.agentName.value, "Nova");
  passed("Text-chosen agent name is available before the call");
  pc = new wrtc.RTCPeerConnection();
  pc.onconnectionstatechange = () => {
    events.push({
      atMs: Date.now() - started,
      type: "client.connection_state",
      state: pc.connectionState,
    });
  };
  const source = new wrtc.nonstandard.RTCAudioSource();
  sourceTrack = source.createTrack();
  pc.addTrack(sourceTrack, new wrtc.MediaStream([sourceTrack]));
  pc.ontrack = ({ track }) => {
    sink = new wrtc.nonstandard.RTCAudioSink(track);
    sink.ondata = (data) => {
      remoteFormat ||= { rate: 48000, channels: 1 };
      assert.equal(data.bitsPerSample, 16);
      for (const x of data.samples)
        remotePeak = Math.max(remotePeak, Math.abs(x));
      samples.push(normalizeAudio(data, receivedFormats));
    };
  };
  const channel = pc.createDataChannel("oai-events");
  channel.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    const safe = { atMs: Date.now() - started, type: event.type };
    if (event.item_id) safe.itemId = event.item_id;
    if (event.response?.id) safe.responseId = event.response.id;
    if (event.response_id) safe.responseId = event.response_id;
    if (event.call_id) safe.callId = event.call_id;
    if (event.usage) safe.usage = event.usage;
    if (event.transcript) safe.transcript = event.transcript;
    if (event.name) safe.name = event.name;
    if (event.arguments) safe.arguments = event.arguments;
    if (event.type === "response.done") {
      safe.usage = event.response?.usage;
      safe.status = event.response?.status;
      safe.status_details = event.response?.status_details;
    }
    if (event.error) safe.error = event.error;
    if (event.item?.type === "function_call_output") {
      safe.itemType = event.item.type;
      safe.callId = event.item.call_id;
      safe.output = event.item.output;
    }
    events.push(safe);
    if (safe.transcript || safe.name || safe.error)
      console.log(JSON.stringify(safe));
  };
  channel.onopen = () => {
    connectionOpened = true;
    channel.send(JSON.stringify({ type: "response.create" }));
  };
  channel.onclose = () => {
    channelClosed = true;
    events.push({
      atMs: Date.now() - started,
      type: "client.data_channel_closed",
    });
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const realtime = await request("/api/realtime", {
    sdp: offer.sdp,
    direction: "incoming",
  });
  callId = realtime.callId;
  const connectedAt = Date.now();
  await pc.setRemoteDescription({ type: "answer", sdp: realtime.sdp });
  // WebRTC audio source consumes one 10 ms mono frame, including silence between turns.
  timer = setInterval(() => {
    const frame = new Int16Array(480);
    const available = input.subarray(inputOffset, inputOffset + 480);
    frame.set(available);
    inputOffset += available.length;
    source.onData({
      samples: frame,
      sampleRate: 48000,
      bitsPerSample: 16,
      channelCount: 1,
      numberOfFrames: 480,
    });
  }, 10);
  await until(() => connectionOpened, "data channel open");
  passed("Hosted SDP exchange establishes real WebRTC audio and data channels");
  await until(
    () =>
      events.some((e) => e.type === "output_audio_buffer.stopped") &&
      remotePeak > 300,
    "spoken greeting heard",
  );
  passed("Agent greeting reaches the remote audio track with non-silent PCM");
  const beforeFirst = events.length;
  await play(firstSpeech);
  await until(
    () =>
      events
        .slice(beforeFirst)
        .some(
          (e) =>
            e.type ===
              "conversation.item.input_audio_transcription.completed" &&
            /Jordan/i.test(e.transcript || ""),
        ),
    "spoken name transcribed",
  );
  await until(
    async () => {
      finalSession = (await request("/api/session")).session;
      return (
        finalSession.profile.userName.value === "Jordan" &&
        /interview/i.test(finalSession.profile.goal.value || "")
      );
    },
    "voice facts saved by authenticated sideband",
    25000,
  );
  passed(
    "Spoken user name and interview goal are saved through the remember tool",
  );
  await until(
    () =>
      events
        .slice(beforeFirst)
        .some(
          (e) =>
            e.type === "response.output_audio_transcript.done" &&
            /\?/.test(e.transcript || ""),
        ),
    "useful interview question spoken",
  );
  passed(
    "Voice starts useful interview practice before Gmail onboarding finishes",
  );
  const beforeCorrection = events.length;
  await play(correctionSpeech);
  await until(
    async () => {
      finalSession = (await request("/api/session")).session;
      return (
        finalSession.profile.userName.value === "Riley" &&
        finalSession.gmail.status === "deferred"
      );
    },
    "spoken correction and Gmail defer saved",
    25000,
  );
  passed(
    "Spoken name correction replaces the earlier fact; Gmail defer persists",
  );
  await until(
    () =>
      events
        .slice(beforeCorrection)
        .some((e) => e.type === "response.output_audio_transcript.done"),
    "response after correction",
  );
  if (endMode === "limit") {
    await until(
      () => channelClosed,
      "two-minute server cap closes provider audio",
      realtime.limitSeconds * 1000 + 15000,
    );
    const elapsedMs = Date.now() - connectedAt;
    assert.ok(
      elapsedMs >= 105000 && elapsedMs <= 135000,
      `Expected two-minute cap, observed ${elapsedMs}ms`,
    );
    finalSession = (await request("/api/session")).session;
    // Socket closure can arrive a moment before the final Blob write.
    await until(
      async () => {
        finalSession = (await request("/api/session")).session;
        return finalSession.call.status === "ended";
      },
      "time-limit ending persisted",
      15000,
    );
    assert.ok(
      finalSession.messages.some((m) => /two-minute demo limit/.test(m.text)),
    );
    limitClosure = { elapsedMs, limitSeconds: realtime.limitSeconds };
    providerClosure = {
      channelClosed,
      connectionState: pc.connectionState,
      atMs: Date.now() - started,
      localCloseRequested: false,
    };
    cleanHangup = true;
    passed(
      "The two-minute server cap ends provider audio and persists its reason without manual hangup",
    );
  } else {
    const beforeHangup = events.length;
    await play(hangupSpeech);
    await until(
      () => {
        const ending = events
          .slice(beforeHangup)
          .find(
            (event) =>
              event.type === "response.function_call_arguments.done" &&
              event.name === "end_call" &&
              event.responseId &&
              event.callId,
          );
        if (!ending) return false;
        const completed = events.find(
          (event) =>
            event.type === "response.done" &&
            event.responseId === ending.responseId &&
            event.status === "completed",
        );
        if (!completed) return false;
        assert.deepEqual(JSON.parse(ending.arguments), {});
        completedEndCall = {
          responseId: ending.responseId,
          callId: ending.callId,
          completedAtMs: completed.atMs,
        };
        return true;
      },
      "completed end_call after spoken hangup",
      20000,
    );
    passed(
      "A spoken request to hang up invokes end_call in a completed response",
    );
    await until(
      async () => {
        finalSession = (await request("/api/session")).session;
        return finalSession.call.status === "ended";
      },
      "server ends the call without a client hangup request",
      15000,
    );
    assert.ok(
      finalSession.messages.some((message) =>
        /Call ended · continuing in messages/.test(message.text),
      ),
      "Spoken-hangup server event is recorded",
    );
    await until(
      () =>
        channelClosed ||
        ["closed", "failed", "disconnected"].includes(pc.connectionState),
      "provider closes the WebRTC channel or connection",
      20000,
    );
    providerClosure = {
      channelClosed,
      connectionState: pc.connectionState,
      atMs: Date.now() - started,
      localCloseRequested: false,
    };
    cleanHangup = true;
    assert.equal(
      events.filter(
        (event) =>
          event.type === "response.created" &&
          event.atMs > completedEndCall.completedAtMs,
      ).length,
      0,
      "No new model response starts after end_call completes",
    );
    passed(
      "The provider connection closes after spoken hangup without manual termination",
    );
  }
  // Allow the final sideband receipt and shared-budget settlement to persist.
  await delay(2000);
  const resumed = await request("/api/chat", {
    id: crypto.randomUUID(),
    resume: true,
  });
  finalSession = resumed.session;
  assert.equal(finalSession.profile.userName.value, "Riley");
  assert.match(finalSession.profile.goal.value, /interview/i);
  assert.ok(
    finalSession.messages.some(
      (m) => m.channel === "voice" && m.role === "user",
    ),
  );
  assert.equal(finalSession.messages.at(-1).channel, "text");
  assert.ok(events.some((e) => e.type === "conversation.item.truncated"));
  assert.ok(
    finalSession.messages.some((m) => m.channel === "voice" && m.interrupted),
  );
  passed(
    "Barging in stops assistant audio and marks the interrupted transcript",
  );
  passed(
    "Hangup ends the call and text resumes with voice memory and transcripts intact",
  );
  assert.equal(
    events.filter((e) => e.type === "error").length,
    0,
    "Realtime protocol errors",
  );
  passed("Realtime event stream contains no protocol errors");
} catch (error) {
  issues.push(error instanceof Error ? error.message : String(error));
  console.error("FAIL", issues.at(-1));
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  if (callId && !cleanHangup) {
    try {
      finalSession = (await request("/api/call/end", { callId })).session;
    } catch (error) {
      issues.push(`Cleanup: ${error.message}`);
    }
  }
  sink?.stop();
  sourceTrack?.stop();
  pc?.close();
  const pcm = Buffer.concat(samples);
  if (remoteFormat && pcm.length)
    await writeFile(`${out}/agent-received.wav`, wavBuffer(pcm, remoteFormat));
  const usage = events
    .filter((e) => e.type === "response.done")
    .map((e) => e.usage)
    .filter(Boolean);
  const report = {
    at: new Date().toISOString(),
    base,
    label: label || null,
    durationMs: Date.now() - started,
    paidCallAttempts: callId ? 1 : 0,
    serverReservationUSD: callId ? 1.25 : 0,
    checks,
    issues,
    completedEndCall,
    endMode,
    limitClosure,
    providerClosure,
    audio: {
      receivedBytes: pcm.length,
      peak: remotePeak,
      format: remoteFormat,
      receivedFormats: [...receivedFormats],
    },
    usage,
    finalSession,
    events,
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(`Report: ${out}/report.json`);
  // Native WebRTC's internal thread can otherwise outlive closed JS handles.
  setTimeout(() => process.exit(process.exitCode || 0), 1000);
}
