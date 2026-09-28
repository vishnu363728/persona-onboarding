/** Complete real onboarding journey. Offline by default; one call, no retries. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeAudio, syntheticSpeech, wavBuffer } from "./voice-audio.mjs";

const args = process.argv.slice(2);
const option = (name) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const live = args.includes("--run"),
  prepareOnly = args.includes("--prepare-only");
if (args.includes("--help") || (!live && !prepareOnly)) {
  console.log(`Offline preparation: node scripts/voice-onboarding-smoke.mjs --prepare-only
Live (only after deployment authorization): node scripts/voice-onboarding-smoke.mjs <origin> --run --ledger-cents=<fresh-current-cents> [--label=onboarding]
One text name, one incoming call (90s test watchdog), four synthetic spoken turns,
one typed memory check. No retry, direct provider calls, Google consent or ledger changes.
Uses the user-authorized1000c global cap; needs51c voice minimum+25c text/QA margin.
Assertions remain strict: name→goal, brief tangent→goal, actual Gmail tool/card,
Gmail defer, saved memory after normal hangup. Artifacts: output/qa/voice-onboarding/.`);
  process.exit(0);
}
assert.ok(live !== prepareOnly);
for (const arg of args.filter((a) => a.startsWith("--")))
  assert.match(
    arg,
    /^(--run|--prepare-only|--ledger-cents=\d+(?:\.\d+)?|--label=[a-z0-9][a-z0-9-]{0,31})$/,
  );
const targets = args.filter((a) => !a.startsWith("--"));
assert.ok(targets.length <= 1);
const url = new URL(targets[0] || "http://127.0.0.1:4317");
assert.ok(["http:", "https:"].includes(url.protocol));
assert.ok(!url.username && !url.password && !url.search && !url.hash);
assert.equal(url.pathname, "/");
const base = url.origin;
const observedLedgerCents =
  option("ledger-cents") === undefined ? null : Number(option("ledger-cents"));
const globalCapCents = 1000,
  voiceMinimumCents = 51,
  testMarginCents = 25;
if (live) {
  assert.ok(
    Number.isFinite(observedLedgerCents) && observedLedgerCents >= 0,
    "Fresh ledger observation required",
  );
  assert.ok(
    observedLedgerCents + voiceMinimumCents + testMarginCents <= globalCapCents,
    "Insufficient protected budget; do not erase holds",
  );
}
const runId = `${option("label") || (prepareOnly ? "prepared" : "journey")}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const out = `output/qa/voice-onboarding/${runId}`;
await mkdir("output/qa/voice-onboarding", { recursive: true });
await mkdir(out);
const speech = {
  name: "I'm Riley.",
  tangent: "How does this work?",
  goal: "I'd like help keeping track of my week.",
  skip: "Let's skip Gmail for now.",
};
const initialText = "Call yourself Appy.";
const typedPrompt =
  "What did I name you, what's my name, what do I want help with, and did I connect Gmail? Keep it short.";
const hardStopSeconds = 90,
  started = Date.now();
const atMs = () => Date.now() - started;
const events = [],
  requests = [],
  checks = [],
  issues = [],
  stages = [],
  samples = [];
const formats = new Set(),
  pendingResponses = new Set(),
  playingResponses = new Set();
const utterances = new Map();
let cookie = "",
  pc,
  sourceTrack,
  sink,
  sourceTimer,
  watchdog,
  channel,
  callId,
  endTask;
let initialSession, namedSession, latestSession, finalSession, typedReply;
let expectedContextContract,
  contextReady = false,
  channelOpened = false,
  channelClosed = false;
let callStartedAt, callClosedAt, localClosedAt, manualStop;
let input = new Int16Array(),
  inputOffset = 0,
  peak = 0,
  lastResponseActivity = 0;
let paidCallAttempts = 0,
  paidTextAttempts = 0,
  hardStop = false,
  interrupted = false,
  success = false;
const redact = (error) =>
  String(error instanceof Error ? error.message : error)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1500);
function pass(description) {
  checks.push(description);
  console.log("PASS", description);
}
function aborted() {
  if (hardStop || interrupted)
    throw new Error(hardStop ? "90s test call watchdog fired" : "Interrupted");
}
async function request(path, body, timeout = 15000) {
  const evidence = {
    atMs: atMs(),
    path,
    method: body === undefined ? "GET" : "POST",
  };
  requests.push(evidence);
  const response = await fetch(base + path, {
    method: evidence.method,
    headers: { origin: base, cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  evidence.status = response.status;
  evidence.completedAtMs = atMs();
  const nextCookie = response.headers.get("set-cookie");
  if (nextCookie) cookie = nextCookie.split(";")[0];
  const data = await response.json();
  if (!response.ok) evidence.error = redact(data.error || response.status);
  assert.equal(
    response.status,
    200,
    `${path}: ${redact(data.error || response.status)}`,
  );
  return data;
}
async function until(check, description, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    aborted();
    if (await check()) return;
    if (channelClosed) throw new Error(`Call closed before ${description}`);
    await delay(interval);
  }
  throw new Error(`Timed out: ${description}`);
}
function stopAudioInput() {
  input = new Int16Array();
  inputOffset = 0;
  sourceTrack?.stop();
  clearInterval(sourceTimer);
}
function endThroughApplication(reason) {
  if (endTask) return endTask;
  manualStop = { reason, atMs: atMs(), callIdKnown: !!callId };
  stopAudioInput();
  endTask = request("/api/call/end", callId ? { callId } : {}, 20000)
    .then((data) => {
      finalSession = data.session;
      manualStop.acknowledgedAtMs = atMs();
    })
    .catch((error) => {
      manualStop.error = redact(error);
      issues.push(`Hangup: ${redact(error)}`);
    });
  return endTask;
}
const interrupt = () => {
  interrupted = true;
  if (paidCallAttempts) void endThroughApplication("process signal");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
// Must match src/lib/voice-contract.ts. Compare all eight canonical fields.
function voiceContextContract(session) {
  return JSON.stringify([
    session.model,
    session.instructions,
    session.tools?.map((t) => t.name).sort(),
    session.audio?.output?.voice,
    session.audio?.input?.transcription?.model,
    session.audio?.input?.turn_detection?.type,
    session.output_modalities,
    session.max_output_tokens,
  ]);
}
function assistantText(after) {
  return events
    .slice(after)
    .filter((e) => e.type === "response.output_audio_transcript.done")
    .map((e) => e.transcript || "")
    .join(" ");
}
const asksName =
  /(?:what|who|how|may|can).{0,55}(?:your name|call you|address you|speaking with)|name.{0,20}(?:go by|use for you)/i;
const asksGoal =
  /(?:what|anything|how).{0,100}(?:help|hand with|work on|working on|easier|support|off your plate)|(?:help|hand).{0,35}(?:with|today|first)/i;
const genericMenu =
  /writing.{0,40}planning|planning.{0,40}decision|nice to meet you in real.?time/i;
function concise(text, label, max = 650) {
  assert.ok(
    text.length > 0 && text.length <= max,
    `${label} should stay short (actual${text.length}characters)`,
  );
  assert.doesNotMatch(
    text,
    genericMenu,
    `${label} must not fall into the generic capability menu`,
  );
}
async function stageResult(
  label,
  after,
  stateCheck,
  timeout = 17000,
  waitForPlayback = true,
) {
  let lastPoll = 0,
    stateMatches = false;
  await until(
    async () => {
      if (Date.now() - lastPoll >= 600) {
        lastPoll = Date.now();
        latestSession = (await request("/api/session", undefined, 5000))
          .session;
        stateMatches = stateCheck(latestSession);
      }
      return (
        stateMatches &&
        !!assistantText(after) &&
        pendingResponses.size === 0 &&
        (waitForPlayback
          ? playingResponses.size === 0
          : /Gmail/i.test(assistantText(after))) &&
        Date.now() - lastResponseActivity >= 900
      );
    },
    label,
    timeout,
  );
  const text = assistantText(after);
  stages.push({ label, completedAtMs: atMs(), text, session: latestSession });
  console.log(
    JSON.stringify({
      stage: label,
      spoken: text,
      userName: latestSession.profile.userName,
      goal: latestSession.profile.goal,
      gmail: latestSession.gmail.status,
    }),
  );
  return text;
}
async function say(label) {
  const after = events.length;
  if (playingResponses.size)
    events.push({ type: "client.barge_in", atMs: atMs(), label });
  events.push({
    type: "client.synthetic_speech",
    atMs: atMs(),
    label,
    text: speech[label],
  });
  input = utterances.get(label);
  inputOffset = 0;
  await until(
    () => inputOffset >= input.length,
    `${label} audio delivery`,
    input.length / 48 + 1500,
  );
  return after;
}
try {
  for (const [label, text] of Object.entries(speech))
    utterances.set(label, await syntheticSpeech(out, `user-${label}`, text));
  if (prepareOnly) {
    pass("All four synthetic turns prepared offline; no network/model calls");
    success = true;
  } else {
    const initial = await request("/api/session");
    initialSession = initial.session;
    assert.ok(cookie && initial.capabilities.voice);
    assert.equal(initialSession.profile.agentName.value, null);
    paidTextAttempts++;
    namedSession = (
      await request("/api/chat", { id: randomUUID(), text: initialText }, 30000)
    ).session;
    assert.equal(namedSession.profile.agentName.value, "Appy");
    assert.equal(namedSession.profile.userName.status, "unknown");
    assert.equal(namedSession.profile.goal.status, "unknown");
    assert.equal(
      namedSession.call.status,
      "ringing",
      "Agent name should lead into the first incoming call",
    );
    pass("Name Appy in text → actual incoming call offered");

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
    sourceTrack.enabled = false;
    pc.addTrack(sourceTrack, new wrtc.MediaStream([sourceTrack]));
    pc.ontrack = ({ track }) => {
      sink = new wrtc.nonstandard.RTCAudioSink(track);
      sink.ondata = (data) => {
        if (data.bitsPerSample !== 16) return;
        for (const value of data.samples)
          peak = Math.max(peak, Math.abs(value));
        samples.push(normalizeAudio(data, formats));
      };
    };
    channel = pc.createDataChannel("oai-events");
    channel.onopen = () => {
      channelOpened = true;
      events.push({ atMs: atMs(), type: "client.channel_open" });
    };
    channel.onclose = () => {
      channelClosed = true;
      callClosedAt = atMs();
      events.push({
        atMs: atMs(),
        type: "client.channel_closed",
        beforeLocalCleanup: localClosedAt === undefined,
      });
    };
    channel.onmessage = ({ data }) => {
      try {
        const e = JSON.parse(data),
          safe = { atMs: atMs(), type: e.type };
        if (e.response_id || e.response?.id)
          safe.responseId = e.response_id || e.response.id;
        if (e.item_id || e.item?.id) safe.itemId = e.item_id || e.item.id;
        for (const field of [
          "transcript",
          "call_id",
          "name",
          "arguments",
          "usage",
        ])
          if (e[field] !== undefined) safe[field] = e[field];
        if (["session.created", "session.updated"].includes(e.type))
          safe.configuration = {
            model: e.session?.model,
            instructionCharacters: e.session?.instructions?.length,
            instructionsSha256: createHash("sha256")
              .update(e.session?.instructions || "")
              .digest("hex"),
            contractSha256: createHash("sha256")
              .update(voiceContextContract(e.session || {}))
              .digest("hex"),
            matchesExpectedContract:
              voiceContextContract(e.session || {}) === expectedContextContract,
            maxOutputTokens: e.session?.max_output_tokens,
            truncation: e.session?.truncation,
          };
        if (e.type === "response.created") {
          pendingResponses.add(safe.responseId);
          lastResponseActivity = Date.now();
        }
        if (e.type === "response.done") {
          pendingResponses.delete(safe.responseId);
          lastResponseActivity = Date.now();
          safe.status = e.response?.status;
          safe.statusDetails = e.response?.status_details;
          safe.usage = e.response?.usage;
        }
        if (e.type === "output_audio_buffer.started") {
          playingResponses.add(safe.responseId);
          lastResponseActivity = Date.now();
        }
        if (
          [
            "output_audio_buffer.stopped",
            "output_audio_buffer.cleared",
          ].includes(e.type)
        ) {
          playingResponses.clear();
          lastResponseActivity = Date.now();
        }
        if (e.error) {
          safe.error = { code: e.error.code, message: redact(e.error.message) };
          issues.push(`Realtime: ${safe.error.message}`);
        }
        events.push(safe);
        if (
          ["session.created", "session.updated"].includes(e.type) &&
          typeof expectedContextContract === "string" &&
          voiceContextContract(e.session || {}) === expectedContextContract &&
          !contextReady &&
          !manualStop &&
          !hardStop &&
          !interrupted &&
          !channelClosed
        ) {
          contextReady = true;
          sourceTrack.enabled = true;
          events.push({ atMs: atMs(), type: "client.context_ready" });
          channel.send(JSON.stringify({ type: "response.create" }));
          events.push({ atMs: atMs(), type: "client.response.create" });
        }
      } catch (error) {
        issues.push(`Event parsing: ${redact(error)}`);
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    callStartedAt = Date.now();
    paidCallAttempts++;
    watchdog = setTimeout(() => {
      hardStop = true;
      issues.push("90s test call watchdog fired");
      void endThroughApplication("test watchdog");
    }, hardStopSeconds * 1000);
    const realtime = await request(
      "/api/realtime",
      { sdp: offer.sdp, direction: "incoming" },
      35000,
    );
    callId = realtime.callId;
    expectedContextContract = realtime.contextContract;
    assert.ok(callId);
    assert.equal(typeof expectedContextContract, "string");
    if (hardStop || interrupted) {
      await endThroughApplication("late SDP cleanup");
      aborted();
    }
    await pc.setRemoteDescription({ type: "answer", sdp: realtime.sdp });
    sourceTimer = setInterval(() => {
      const frame = new Int16Array(480);
      frame.set(input.subarray(inputOffset, inputOffset + 480));
      inputOffset += 480;
      source.onData({
        samples: frame,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: 480,
      });
    }, 10);
    await until(
      () => channelOpened && contextReady,
      "exact provider context verification",
      15000,
    );
    const greeting = await stageResult(
      "incoming greeting asks user name",
      0,
      () => true,
    );
    concise(greeting, "Greeting");
    assert.match(greeting, /Appy/i);
    assert.match(greeting, asksName);
    assert.ok(peak > 300, "Actual audible model speech received");
    pass("Incoming voice identifies Appy and asks the missing user name");

    let after = await say("name");
    const afterName = await stageResult(
      "spoken name saved, goal requested",
      after,
      (s) =>
        s.profile.userName.status === "known" &&
        /^Riley$/i.test(s.profile.userName.value || ""),
    );
    concise(afterName, "After name");
    assert.match(afterName, asksGoal);
    assert.doesNotMatch(afterName, asksName);
    assert.equal(latestSession.profile.goal.status, "unknown");
    pass("Spoken Riley is saved; voice moves to the missing goal");

    after = await say("tangent");
    const tangent = await stageResult(
      "tangent answered, onboarding goal resumed",
      after,
      (s) =>
        s.profile.userName.value === "Riley" &&
        s.profile.goal.status === "unknown",
    );
    concise(tangent, "How this works", 650);
    assert.match(tangent, /get to know|learn|personal|help|set.?up|onboard/i);
    assert.match(tangent, asksGoal);
    assert.doesNotMatch(tangent, asksName);
    pass(
      "How does this work gets a short answer and returns to the missing goal",
    );

    after = await say("goal");
    const goalReply = await stageResult(
      "goal saved and real Gmail connection card offered",
      after,
      (s) =>
        s.profile.goal.status === "known" &&
        /week|weekly|schedule|track/i.test(s.profile.goal.value || "") &&
        s.gmail.status === "offered",
      30000,
      false,
    );
    concise(goalReply, "Goal and Gmail handoff", 800);
    const gmailOffer = events
      .slice(after)
      .find(
        (e) =>
          e.type === "response.function_call_arguments.done" &&
          e.name === "offer_gmail",
      );
    assert.ok(
      gmailOffer,
      "Actual offer_gmail tool must run, not just a spoken promise",
    );
    assert.ok(
      events
        .slice(after)
        .some(
          (e) =>
            e.type === "response.done" &&
            e.responseId === gmailOffer.responseId &&
            e.status === "completed",
        ),
    );
    assert.match(goalReply, /Gmail/i);
    assert.doesNotMatch(goalReply, asksName);
    pass(
      "Weekly tracking goal is saved and offer_gmail makes the real connection card available",
    );

    after = await say("skip");
    const skipReply = await stageResult(
      "Gmail defer saved without another pitch",
      after,
      (s) => s.gmail.status === "deferred",
      25000,
    );
    concise(skipReply, "Skip Gmail");
    assert.doesNotMatch(
      skipReply,
      /\b(?:tap|click|please connect|go ahead and connect|let's connect|want to connect|would you like to (?:connect|link)|you can connect)\b/i,
    );
    assert.equal(latestSession.profile.userName.value, "Riley");
    assert.match(
      latestSession.profile.goal.value || "",
      /week|weekly|schedule|track/i,
    );
    assert.ok(
      !events
        .slice(after)
        .some(
          (e) =>
            e.type === "response.function_call_arguments.done" &&
            e.name === "offer_gmail",
        ),
      "A Gmail skip cannot re-offer the tool",
    );
    pass(
      "Gmail is actually deferred; conversation continues without a repeated pitch",
    );

    assert.equal(pendingResponses.size, 0);
    assert.equal(playingResponses.size, 0);
    await endThroughApplication("normal completed-turn hangup");
    clearTimeout(watchdog);
    aborted();
    assert.ok(!manualStop.error, manualStop.error);
    localClosedAt = atMs();
    pc.close();
    paidTextAttempts++;
    finalSession = (
      await request("/api/chat", { id: randomUUID(), text: typedPrompt }, 30000)
    ).session;
    typedReply = finalSession.messages.at(-1);
    assert.equal(typedReply.role, "assistant");
    assert.equal(typedReply.channel, "text");
    for (const pattern of [
      /Appy/i,
      /Riley/i,
      /week|weekly|schedule|track/i,
      /Gmail/i,
    ])
      assert.match(typedReply.text, pattern);
    assert.equal(finalSession.gmail.status, "deferred");
    assert.equal(finalSession.call.status, "ended");
    assert.doesNotMatch(
      typedReply.text,
      /token spending limit|not enough token budget/i,
    );
    assert.ok(typedReply.text.length <= 650);
    pass(
      "Clean hangup → typed follow-up remembers Appy, Riley, weekly goal and skipped Gmail",
    );
    assert.equal(events.filter((e) => e.type === "error").length, 0);
    success = true;
  }
} catch (error) {
  issues.push(redact(error));
  console.error("FAIL", issues.at(-1));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  stopAudioInput();
  if (paidCallAttempts && !manualStop)
    await endThroughApplication("failure cleanup");
  if (endTask) await endTask;
  sink?.stop();
  if (pc && localClosedAt === undefined) {
    localClosedAt = atMs();
    pc.close();
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (issues.length) {
    success = false;
    process.exitCode = 1;
  }
  const pcm = Buffer.concat(samples);
  if (pcm.length)
    await writeFile(
      `${out}/agent-received.wav`,
      wavBuffer(pcm, { rate: 48000, channels: 1 }),
      { flag: "wx" },
    );
  const unique = new Map();
  for (const event of events)
    if (event.type === "response.done" && event.responseId && event.usage)
      unique.set(event.responseId, {
        responseId: event.responseId,
        status: event.status,
        usage: event.usage,
      });
  const report = {
    at: new Date().toISOString(),
    runId,
    base,
    mode: live ? "live" : "offline-preparation",
    success,
    durationMs: Date.now() - started,
    paidTextAttempts,
    paidCallAttempts,
    input: { initialText, speech, typedPrompt },
    preparedSpeech: Object.fromEntries(
      [...utterances].map(([label, audio]) => [
        label,
        { seconds: audio.length / 48000, sampleRate: 48000 },
      ]),
    ),
    budget: {
      observedLedgerCents,
      globalCapCents,
      voiceMinimumCents,
      testMarginCents,
      ledgerChangedByHarness: false,
    },
    voice: {
      hardStopSeconds,
      hardStop,
      callId,
      callElapsedMs: callStartedAt
        ? (callClosedAt === undefined ? Date.now() : started + callClosedAt) -
          callStartedAt
        : null,
      channelOpened,
      contextReady,
      callClosedAt,
      localClosedAt,
      manualStop,
      pendingResponses: [...pendingResponses],
    },
    audio: {
      receivedBytes: pcm.length,
      peak,
      formats: [...formats],
      sampleRate: 48000,
    },
    googleConsent: { attempted: false, verified: false },
    checks,
    issues,
    stages,
    typedReply,
    initialSession,
    namedSession,
    finalSession,
    events,
    requests,
    uniqueResponseUsage: [...unique.values()],
    transcriptionUsage: events
      .filter(
        (e) =>
          e.type === "conversation.item.input_audio_transcription.completed" &&
          e.usage,
      )
      .map((e) => ({ itemId: e.itemId, usage: e.usage })),
  };
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      success,
      checks: checks.length,
      issues,
      report: `${out}/report.json`,
    }),
  );
  // Native WebRTC worker shutdown can outlive closed JS handles. Preserve the
  // recorded assertion result and exit after all evidence has been flushed.
  if (live) setTimeout(() => process.exit(process.exitCode || 0), 500);
}
