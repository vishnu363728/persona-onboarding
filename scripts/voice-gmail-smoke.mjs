/**
 * One short real WebRTC call, using the application's existing shared ledger.
 * No Google consent, direct provider API, API key, or initial text-model request.
 * Offline preparation: node scripts/voice-gmail-smoke.mjs --prepare-only
 * Paid execution requires --run and a freshly checked --ledger-cents=<number>.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeAudio, syntheticSpeech, wavBuffer } from "./voice-audio.mjs";

const args = process.argv.slice(2);
const live = args.includes("--run");
const prepareOnly = args.includes("--prepare-only");
const textCheck = args.includes("--text-check");
const value = (key) =>
  args.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
if (args.includes("--help") || (!live && !prepareOnly)) {
  console.log(`Focused Gmail voice smoke (offline unless --run is explicit).
  node scripts/voice-gmail-smoke.mjs --prepare-only [--label=prep]
  node scripts/voice-gmail-smoke.mjs https://persona-onboarding-demo.vercel.app --run --ledger-cents=<fresh-current-cents> [--label=gmail] [--text-check]

One outgoing call, no initial text, target 20–35s, /api/call/end watchdog at 45s.
Requires a 125c reservation inside the existing 500c ledger. Never resets it.
Default verifies saved state after hangup without text generation.
--text-check explicitly opts into at most one paid post-call resume.
Evidence is a new timestamp+UUID folder under output/qa; no Google consent.`);
  process.exit(0);
}
assert.ok(!(live && prepareOnly), "Choose --run or --prepare-only, never both");
const known =
  /^(--run|--prepare-only|--text-check|--label=[a-z0-9][a-z0-9-]{0,31}|--ledger-cents=\d+(?:\.\d+)?)$/;
for (const arg of args.filter((arg) => arg.startsWith("--")))
  assert.match(arg, known, "Unrecognized or invalid option");
const targets = args.filter((arg) => !arg.startsWith("--"));
assert.ok(targets.length <= 1, "Specify one application origin");
const url = new URL(targets[0] || "http://127.0.0.1:4317");
assert.ok(["http:", "https:"].includes(url.protocol));
assert.ok(!url.username && !url.password && !url.search && !url.hash);
assert.equal(url.pathname, "/", "Use the application origin without a path");
const base = url.origin;
const observedLedgerCents =
  value("ledger-cents") === undefined ? null : Number(value("ledger-cents"));
if (live) {
  assert.ok(
    Number.isFinite(observedLedgerCents) && observedLedgerCents >= 0,
    "Check the existing ledger first and provide --ledger-cents=<current cents>",
  );
  assert.ok(
    observedLedgerCents + 125 <= 500,
    "Not enough room for the125c voice reservation; do not reset or replace the ledger",
  );
}
const label = value("label") || (prepareOnly ? "prepared" : "smoke");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const out = `output/qa/voice-gmail-${label}-${runId}`;
await mkdir("output/qa", { recursive: true });
await mkdir(out); // Fail on collision; never overwrite earlier evidence.

const startedAt = Date.now();
const events = [],
  checks = [],
  issues = [],
  samples = [];
const formats = new Set();
let cookie = "",
  callId,
  finalSession,
  pc,
  sourceTrack,
  sink,
  sourceTimer,
  watchdog;
let input = new Int16Array(),
  offset = 0,
  peak = 0;
let callStartedAt,
  connectedAt,
  channelOpened = false,
  channelClosed = false;
let paidCallAttempts = 0,
  paidTextAttempts = 0,
  hardStop = false,
  interrupted = false;
let providerClosure,
  completedEndCall,
  localCloseAt,
  endTask,
  manualStop,
  evidenceAtOffer;
let prepareEvidence,
  success = false,
  initialSession;
const redact = (error) =>
  String(error instanceof Error ? error.message : error)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1000);
const atMs = () => Date.now() - startedAt;
function pass(check) {
  checks.push(check);
  console.log("PASS", check);
}
async function request(path, body, timeout = 7000) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: base, cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const nextCookie = response.headers.get("set-cookie");
  if (nextCookie) cookie = nextCookie.split(";")[0];
  const data = await response.json();
  assert.equal(
    response.status,
    200,
    `${path}: ${redact(data.error || `HTTP ${response.status}`)}`,
  );
  return data;
}
function aborted() {
  if (hardStop)
    throw new Error("45-second watchdog requested normal application hangup");
  if (interrupted)
    throw new Error("Interrupted; normal application hangup requested");
}
async function until(predicate, description, milliseconds, interval = 120) {
  const expires = Date.now() + milliseconds;
  while (Date.now() < expires) {
    aborted();
    if (await predicate()) return;
    await delay(interval);
  }
  throw new Error(`Timed out: ${description}`);
}
async function play(pcm) {
  input = pcm;
  offset = 0;
  await until(
    () => offset >= input.length,
    "synthetic speech delivery",
    pcm.length / 48 + 1500,
  );
}
function endThroughApplication(reason) {
  if (endTask) return endTask;
  manualStop = {
    reason,
    requestedAtMs: atMs(),
    afterCallStartMs: callStartedAt ? Date.now() - callStartedAt : null,
  };
  input = new Int16Array();
  offset = 0;
  // Empty body intentionally handles a handshake whose response/ID was lost.
  endTask = request("/api/call/end", callId ? { callId } : {}, 16000)
    .then((data) => {
      finalSession = data.session;
      manualStop.acknowledgedAtMs = atMs();
    })
    .catch((error) => {
      manualStop.error = redact(error);
      issues.push(`Cleanup: ${redact(error)}`);
    });
  return endTask;
}
const interrupt = () => {
  interrupted = true;
  if (paidCallAttempts) void endThroughApplication("process signal");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const introduction = await syntheticSpeech(
    out,
    "user-gmail-request",
    "I'm Riley. Please help me connect Gmail now. Show me the connection option.",
  );
  const hangup = await syntheticSpeech(
    out,
    "user-hangup",
    "Please hang up now. Let's continue in messages.",
  );
  prepareEvidence = {
    inputRate: 48000,
    channels: 1,
    introSeconds: introduction.length / 48000,
    hangupSeconds: hangup.length / 48000,
  };
  if (prepareOnly) {
    pass(
      "Offline synthetic speech prepared as 48kHz mono PCM; no network or model calls",
    );
    success = true;
  } else {
    const first = await request("/api/session");
    initialSession = first.session;
    assert.ok(
      first.capabilities.voice,
      "Voice must be configured before reserving budget",
    );
    assert.ok(
      first.capabilities.gmail,
      "Gmail must be configured before testing the connection offer",
    );
    assert.ok(cookie, "Application session cookie was established");
    const { default: wrtc } = await import("@roamhq/wrtc");
    pc = new wrtc.RTCPeerConnection();
    pc.onconnectionstatechange = () =>
      events.push({
        atMs: atMs(),
        type: "client.connection_state",
        state: pc.connectionState,
      });
    const source = new wrtc.nonstandard.RTCAudioSource();
    sourceTrack = source.createTrack();
    pc.addTrack(sourceTrack, new wrtc.MediaStream([sourceTrack]));
    pc.ontrack = ({ track }) => {
      sink = new wrtc.nonstandard.RTCAudioSink(track);
      sink.ondata = (data) => {
        if (data.bitsPerSample !== 16) {
          issues.push("Unexpected remote PCM format");
          return;
        }
        for (const sample of data.samples)
          peak = Math.max(peak, Math.abs(sample));
        samples.push(normalizeAudio(data, formats));
      };
    };
    const channel = pc.createDataChannel("oai-events");
    channel.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data);
        const safe = { atMs: atMs(), type: event.type };
        if (event.item_id) safe.itemId = event.item_id;
        if (event.response_id || event.response?.id)
          safe.responseId = event.response_id || event.response.id;
        if (event.call_id) safe.toolCallId = event.call_id;
        if (event.transcript) safe.transcript = event.transcript;
        if (event.name) safe.name = event.name;
        if (event.arguments) safe.arguments = event.arguments;
        if (event.usage) safe.usage = event.usage;
        if (event.type === "response.done") {
          safe.status = event.response?.status;
          safe.usage = event.response?.usage;
        }
        if (event.error)
          safe.error = {
            code: event.error.code,
            message: redact(event.error.message),
          };
        events.push(safe);
        if (safe.transcript || safe.name) console.log(JSON.stringify(safe));
      } catch (error) {
        issues.push(`Event parsing: ${redact(error)}`);
      }
    };
    channel.onopen = () => {
      channelOpened = true;
      connectedAt = Date.now();
      channel.send(JSON.stringify({ type: "response.create" }));
    };
    channel.onclose = () => {
      channelClosed = true;
      events.push({
        atMs: atMs(),
        type: "client.data_channel_closed",
        beforeLocalClose: !localCloseAt,
        beforeManualStop: !manualStop,
      });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    callStartedAt = Date.now();
    paidCallAttempts = 1; // Never retry a potentially billable handshake.
    watchdog = setTimeout(() => {
      hardStop = true;
      issues.push("Hard deadline reached; /api/call/end requested at 45 seconds");
      void endThroughApplication("45-second hard deadline");
    }, 45000);
    const realtime = await request(
      "/api/realtime",
      { sdp: offer.sdp, direction: "outgoing" },
      20000,
    );
    callId = realtime.callId;
    assert.ok(callId, "Hosted SDP response includes the active call ID");
    await pc.setRemoteDescription({ type: "answer", sdp: realtime.sdp });
    sourceTimer = setInterval(() => {
      const frame = new Int16Array(480),
        available = input.subarray(offset, offset + 480);
      frame.set(available);
      offset += available.length;
      source.onData({
        samples: frame,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: 480,
      });
    }, 10);
    await until(() => channelOpened, "WebRTC data channel", 7000);
    pass(
      "One outgoing call established through the application; no initial text request",
    );
    await until(
      () =>
        peak > 300 &&
        events.some((e) => e.type === "output_audio_buffer.stopped"),
      "audible greeting",
      9000,
    );
    pass("Actual remote audio contains an audible agent greeting");
    const beforeRequest = events.length;
    await play(introduction);
    await until(
      async () => {
        finalSession = (await request("/api/session", undefined, 4000)).session;
        return (
          finalSession.call.id === callId &&
          finalSession.profile.userName.value === "Riley" &&
          finalSession.gmail.status === "offered"
        );
      },
      "authenticated Riley memory and Gmail card offer",
      10000,
      700,
    );
    evidenceAtOffer = finalSession;
    assert.ok(
      events
        .slice(beforeRequest)
        .some(
          (e) =>
            e.type ===
              "conversation.item.input_audio_transcription.completed" &&
            /Riley/i.test(e.transcript || ""),
        ),
      "Synthetic spoken name was actually transcribed",
    );
    assert.ok(
      events
        .slice(beforeRequest)
        .some(
          (e) =>
            e.type === "response.function_call_arguments.done" &&
            e.name === "offer_gmail",
        ),
      "The model used the real server Gmail-offer tool",
    );
    pass(
      "Authenticated application session persisted spoken Riley and an offered Gmail card",
    );
    // Allow a short handoff sentence to finish; never ask an extra model question.
    await until(
      () =>
        events
          .slice(beforeRequest)
          .some(
            (e) =>
              e.type === "response.output_audio_transcript.done" &&
              /gmail/i.test(e.transcript || ""),
          ),
      "spoken Gmail handoff",
      4500,
    );
    pass("Agent spoke a Gmail handoff; full wording is retained for review");
    const beforeHangup = events.length;
    await play(hangup);
    await until(
      () => {
        const ending = events
          .slice(beforeHangup)
          .find(
            (e) =>
              e.type === "response.function_call_arguments.done" &&
              e.name === "end_call",
          );
        const completed =
          ending &&
          events.find(
            (e) =>
              e.type === "response.done" &&
              e.responseId === ending.responseId &&
              e.status === "completed",
          );
        if (!completed) return false;
        assert.deepEqual(JSON.parse(ending.arguments), {});
        completedEndCall = {
          responseId: ending.responseId,
          toolCallId: ending.toolCallId,
          completedAtMs: completed.atMs,
        };
        return true;
      },
      "completed spoken end_call",
      8000,
    );
    await until(
      () => channelClosed,
      "provider data channel closure before local cleanup",
      8000,
    );
    providerClosure = {
      atMs: atMs(),
      channelClosed,
      connectionState: pc.connectionState,
      localCloseRequested: false,
      manualStopRequested: !!manualStop,
    };
    assert.equal(
      manualStop,
      undefined,
      "Spoken hangup must close the provider without fallback intervention",
    );
    clearTimeout(watchdog);
    await until(
      async () => {
        finalSession = (await request("/api/session", undefined, 4000)).session;
        return (
          finalSession.call.id === callId &&
          finalSession.call.status === "ended"
        );
      },
      "hangup persisted in authenticated session",
      5000,
      700,
    );
    assert.equal(finalSession.profile.userName.value, "Riley");
    assert.equal(finalSession.gmail.status, "offered");
    assert.ok(
      finalSession.messages.some(
        (m) => m.channel === "voice" && m.role === "user",
      ),
      "Spoken history persists for the messages view",
    );
    assert.equal(
      events.filter((e) => e.type === "error").length,
      0,
      "Realtime protocol errors",
    );
    pass(
      "Spoken hangup closed the actual provider channel and retained voice memory/history for text",
    );
    if (textCheck) {
      await delay(1500); // Give the authenticated sideband time to settle its hold.
      paidTextAttempts = 1;
      finalSession = (
        await request("/api/chat", { id: randomUUID(), resume: true }, 25000)
      ).session;
      assert.equal(finalSession.profile.userName.value, "Riley");
      assert.equal(finalSession.gmail.status, "offered");
      assert.equal(finalSession.messages.at(-1)?.channel, "text");
      pass(
        "One explicitly requested text resume preserved the voice memory and Gmail offer",
      );
    }
    success = true;
  }
} catch (error) {
  issues.push(redact(error));
  console.error("FAIL", issues.at(-1));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  clearInterval(sourceTimer);
  if (paidCallAttempts && !providerClosure)
    await endThroughApplication("failure cleanup");
  if (endTask) await endTask;
  if (issues.length) {
    success = false;
    process.exitCode = 1;
  }
  sink?.stop();
  sourceTrack?.stop();
  if (pc) {
    localCloseAt = atMs();
    pc.close();
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  const pcm = Buffer.concat(samples);
  if (pcm.length)
    await writeFile(
      `${out}/agent-received.wav`,
      wavBuffer(pcm, { rate: 48000, channels: 1 }),
      { flag: "wx" },
    );
  const uniqueUsage = new Map();
  for (const event of events)
    if (event.type === "response.done" && event.responseId && event.usage)
      uniqueUsage.set(event.responseId, event.usage);
  const report = {
    at: new Date().toISOString(),
    runId,
    label,
    base,
    mode: prepareOnly ? "offline-preparation" : "live",
    success,
    durationMs: Date.now() - startedAt,
    callElapsedMs: callStartedAt
      ? (providerClosure ? providerClosure.atMs + startedAt : Date.now()) -
        callStartedAt
      : null,
    targetCallSeconds: [20, 35],
    hardStopAtSeconds: 45,
    hardStop,
    paidCallAttempts,
    paidTextAttempts,
    observedLedgerCents,
    budget: {
      requestedVoiceReservationCents: live ? 125 : 0,
      callIdConfirmed: !!callId,
      globalCapCents: 500,
      authoritativeEnforcement:
        "Existing application /api/realtime shared ledger; never reset or bypassed",
      settlementVerified: false,
      note: "Inspect the server ledger after the call; client usage receipts are not proof of settlement or an invoice",
    },
    googleConsent: {
      attempted: false,
      verified: false,
      scope:
        "Only spoken request, authenticated saved name, and offered card. No Google consent/login/mail access.",
    },
    textContinuity:
      textCheck && paidTextAttempts
        ? "One explicit text resume attempted; see checks/issues"
        : "No paid text generation. Authenticated post-hangup session is the continuity evidence.",
    checks,
    issues,
    prepareEvidence,
    completedEndCall,
    providerClosure,
    manualStop,
    localCloseAt,
    audio: {
      receivedBytes: pcm.length,
      peak,
      savedFormat: { rate: 48000, channels: 1 },
      receivedFormats: [...formats],
    },
    uniqueResponseUsage: [...uniqueUsage].map(([responseId, usage]) => ({
      responseId,
      usage,
    })),
    transcriptionUsage: events
      .filter(
        (e) =>
          e.type === "conversation.item.input_audio_transcription.completed" &&
          e.usage,
      )
      .map((e) => ({ itemId: e.itemId, usage: e.usage })),
    initialSession,
    evidenceAtOffer,
    finalSession,
    events,
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2), {
    flag: "wx",
  });
  console.log(`Report: ${out}/report.json`);
  // Native WebRTC may retain its own thread after all JS resources are closed.
  if (live) setTimeout(() => process.exit(process.exitCode || 0), 500);
}
