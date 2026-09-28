/**
 * Real application context handoff test. No provider-direct API or ledger edits.
 * Offline: node scripts/voice-context-smoke.mjs --prepare-only
 * Paid: node scripts/voice-context-smoke.mjs <origin> --run --ledger-cents=<fresh cents>
 * One initial text, one <=45s voice call, one immediate text resume; never retries.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeAudio, syntheticSpeech, wavBuffer } from "./voice-audio.mjs";

const args = process.argv.slice(2);
const live = args.includes("--run"),
  prepareOnly = args.includes("--prepare-only"),
  simpleFirstCall = args.includes("--simple-first-call"),
  typedFollowup = args.includes("--typed-followup");
const option = (name) =>
  args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.includes("--help") || (!live && !prepareOnly)) {
  console.log(`Voice context smoke: offline by default; no Google consent required.
  node scripts/voice-context-smoke.mjs --prepare-only [--label=prep]
  node scripts/voice-context-smoke.mjs https://persona-onboarding-demo.vercel.app --run --ledger-cents=<fresh-current-cents> [--label=context] [--simple-first-call] [--typed-followup] [--budget-cents=1000]

One initial text names Appy and Mara, sets a disagreement-at-work interview goal,
and defers calls/Gmail. One manual outgoing call verifies the greeting, accepts a
spoken correction to Riley, then ends normally and immediately resumes in text.
A45s call watchdog uses /api/call/end. No paid retries. Existing shared ledger is authoritative (500c default; explicitly authorized
--budget-cents=1000 selects the raised cap); preflight needs51c voice minimum plus15c test-cost margin.
--simple-first-call selects a separate single-call scenario: name Appy in text,
answer the first incoming call, check its greeting, hang up and immediately resume.
It uses a20s watchdog and no spoken correction. It never runs a second call itself.
--typed-followup explicitly allows ONE extra paid text asking for saved context.
Only with that flag may passive resume return no new assistant message; the new
explicit text step must then prove the retained context without a budget error.
All unknown reservations remain intact. Provide a freshly inspected ledger.
Artifacts: output/qa/voice-context/<unique-label-timestamp-UUID>/report.json + WAV.`);
  process.exit(0);
}
assert.ok(live !== prepareOnly, "Choose --run or --prepare-only");
for (const arg of args.filter((s) => s.startsWith("--")))
  assert.match(
    arg,
    /^(--run|--prepare-only|--simple-first-call|--typed-followup|--label=[a-z0-9][a-z0-9-]{0,31}|--ledger-cents=\d+(?:\.\d+)?|--budget-cents=(?:500|1000))$/,
    "Unknown option",
  );
const targets = args.filter((s) => !s.startsWith("--"));
assert.ok(targets.length <= 1);
const url = new URL(targets[0] || "http://127.0.0.1:4317");
assert.ok(["http:", "https:"].includes(url.protocol));
assert.ok(!url.username && !url.password && !url.search && !url.hash);
assert.equal(url.pathname, "/", "Use an origin without a path");
const base = url.origin;
const observedLedgerCents =
  option("ledger-cents") === undefined ? null : Number(option("ledger-cents"));
const globalCapCents = Number(option("budget-cents") || 500),
  voiceMinimumCents = 51,
  testMarginCents = 15;
if (live) {
  assert.ok(
    Number.isFinite(observedLedgerCents) && observedLedgerCents >= 0,
    "Supply a freshly inspected --ledger-cents value; do not reset any hold",
  );
  assert.ok(
    observedLedgerCents + voiceMinimumCents + testMarginCents <= globalCapCents,
    "Insufficient budget for the51c dynamic minimum and15c test margin; preserve the existing ledger",
  );
}
const label = option("label") || (prepareOnly ? "prepared" : "smoke");
const runId = `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const out = `output/qa/voice-context/${runId}`;
await mkdir("output/qa/voice-context", { recursive: true });
await mkdir(out); // Unique directory, immutable files: never overwrite evidence.

const initialText = simpleFirstCall
  ? "Call yourself Appy."
  : "Call yourself Appy and call me Mara. I want to practice one interview question about resolving a disagreement at work. Skip calls and Gmail for now. Please give me one practice question.";
const hardStopSeconds = simpleFirstCall ? 20 : 45;
const correctionText =
  "Actually, call me Riley instead. Keep the workplace disagreement question.";
const started = Date.now(),
  events = [],
  requests = [],
  checks = [],
  issues = [],
  samples = [];
const formats = new Set();
const atMs = () => Date.now() - started;
const redact = (error) =>
  String(error instanceof Error ? error.message : error)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1000);
let cookie = "",
  initialSession,
  namedSession,
  beforeHangupSession,
  finalSession;
let pc, sourceTrack, sink, sourceTimer, watchdog, callId, endTask, manualStop;
let input = new Int16Array(),
  inputOffset = 0,
  peak = 0;
let callStartedAt,
  callClosedAt,
  localClosedAt,
  channelOpened = false,
  channelClosed = false,
  contextReady = false,
  contextReadyAt,
  expectedContextContract;
let paidTextAttempts = 0,
  paidCallAttempts = 0,
  hardStop = false,
  interrupted = false;
let success = false,
  prepareEvidence,
  greeting,
  textResume,
  explicitTextCheck,
  configurationEvidence;
function pass(check) {
  checks.push(check);
  console.log("PASS", check);
}
function aborted() {
  if (hardStop || interrupted)
    throw new Error(
      hardStop
        ? `${hardStopSeconds}-second call watchdog fired`
        : "Process interrupted",
    );
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
  if (!response.ok) {
    evidence.error = redact(data.error || `HTTP ${response.status}`);
    evidence.code = data.code;
  }
  assert.equal(
    response.status,
    200,
    `${path}: ${redact(data.error || `HTTP ${response.status}`)}`,
  );
  return data;
}
async function until(check, description, timeout, interval = 100) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    aborted();
    if (await check()) return;
    if (channelClosed && description !== "provider channel closed")
      throw new Error(`Call closed before ${description}`);
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
  manualStop = { reason, requestedAtMs: atMs(), callIdKnown: !!callId };
  stopAudioInput(); // Same immediate microphone release as useVoice.end().
  endTask = request("/api/call/end", callId ? { callId } : {}, 16000)
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
// Keep this canonical shape identical to src/lib/voice-contract.ts.
function voiceContextContract(session) {
  return JSON.stringify([
    session.model,
    session.instructions,
    session.tools?.map((tool) => tool.name).sort(),
    session.audio?.output?.voice,
    session.audio?.input?.transcription?.model,
    session.audio?.input?.turn_detection?.type,
    session.output_modalities,
    session.max_output_tokens,
  ]);
}
function sessionMetadata(session) {
  const instructions =
    typeof session?.instructions === "string" ? session.instructions : "";
  return {
    model: session?.model,
    contractSha256: createHash("sha256")
      .update(voiceContextContract(session || {}))
      .digest("hex"),
    matchesExpectedContract:
      typeof expectedContextContract === "string" &&
      voiceContextContract(session || {}) === expectedContextContract,
    instructionCharacters: instructions.length,
    instructionSha256: createHash("sha256").update(instructions).digest("hex"),
    includesAppy: /\bAppy\b/i.test(instructions),
    includesMara: /\bMara\b/i.test(instructions),
    includesDisagreement: /disagreement/i.test(instructions),
    tools: session?.tools?.map((tool) => tool.name || tool.type),
    voice: session?.audio?.output?.voice,
    transcription: session?.audio?.input?.transcription,
    turnDetection: session?.audio?.input?.turn_detection,
    outputModalities: session?.output_modalities,
    maxOutputTokens: session?.max_output_tokens,
    reasoning: session?.reasoning,
    truncation: session?.truncation,
  };
}
try {
  const correction = await syntheticSpeech(
    out,
    "user-correction",
    correctionText,
  );
  prepareEvidence = {
    text: correctionText,
    rate: 48000,
    channels: 1,
    durationSeconds: correction.length / 48000,
  };
  if (prepareOnly) {
    pass("Offline synthetic correction prepared; zero network/model calls");
    success = true;
  } else {
    const initial = await request("/api/session");
    initialSession = initial.session;
    assert.ok(
      initial.capabilities.voice,
      "Voice capability must be configured",
    );
    assert.ok(cookie, "Fresh application session cookie established");
    assert.equal(
      initialSession.profile.agentName.value,
      null,
      "Clean cookie must create a fresh session",
    );
    paidTextAttempts++;
    namedSession = (
      await request("/api/chat", { id: randomUUID(), text: initialText }, 30000)
    ).session;
    assert.equal(namedSession.profile.agentName.value, "Appy");
    if (!simpleFirstCall) {
      assert.equal(namedSession.profile.userName.value, "Mara");
      assert.match(namedSession.profile.goal.value || "", /disagreement/i);
      assert.ok(
        ["deferred", "declined"].includes(namedSession.call.preference),
        "Calls are explicitly skipped",
      );
      assert.ok(
        ["deferred", "declined"].includes(namedSession.gmail.status),
        "Gmail is explicitly skipped",
      );
      pass(
        "One text turn saved Appy, Mara and disagreement interview goal; calls/Gmail deferred",
      );
    } else {
      assert.equal(
        namedSession.call.status,
        "ringing",
        "Naming Appy should trigger the eligible first incoming call",
      );
      pass("One text turn names Appy and starts the eligible incoming call");
    }

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
    sourceTrack.enabled = false; // Match browser: no microphone until verified context.
    pc.addTrack(sourceTrack, new wrtc.MediaStream([sourceTrack]));
    pc.ontrack = ({ track }) => {
      sink = new wrtc.nonstandard.RTCAudioSink(track);
      sink.ondata = (data) => {
        if (data.bitsPerSample !== 16) return;
        for (const sample of data.samples)
          peak = Math.max(peak, Math.abs(sample));
        samples.push(normalizeAudio(data, formats));
      };
    };
    const channel = pc.createDataChannel("oai-events");
    channel.onmessage = ({ data }) => {
      try {
        const event = JSON.parse(data),
          safe = { atMs: atMs(), type: event.type };
        if (event.response_id || event.response?.id)
          safe.responseId = event.response_id || event.response.id;
        if (event.item_id || event.item?.id)
          safe.itemId = event.item_id || event.item.id;
        if (event.call_id) safe.toolCallId = event.call_id;
        if (event.transcript) safe.transcript = event.transcript;
        if (event.name) safe.name = event.name;
        if (event.arguments) safe.arguments = event.arguments;
        if (event.usage) safe.usage = event.usage;
        if (["session.created", "session.updated"].includes(event.type)) {
          safe.configuration = sessionMetadata(event.session);
          console.log(
            JSON.stringify({
              type: event.type,
              configuration: safe.configuration,
            }),
          );
        }
        if (event.type === "response.done") {
          safe.status = event.response?.status;
          safe.statusDetails = event.response?.status_details;
          safe.usage = event.response?.usage;
        }
        if (event.error)
          safe.error = {
            code: event.error.code,
            message: redact(event.error.message),
          };
        events.push(safe);
        if (
          ["session.created", "session.updated"].includes(event.type) &&
          typeof expectedContextContract === "string" &&
          event.session &&
          voiceContextContract(event.session) === expectedContextContract &&
          !contextReady &&
          !manualStop &&
          !hardStop &&
          !interrupted &&
          !channelClosed
        ) {
          contextReady = true;
          contextReadyAt = atMs();
          sourceTrack.enabled = true;
          events.push({
            atMs: atMs(),
            type: "client.context_ready",
            verifiedEventType: event.type,
            exactContextContractMatch: true,
          });
          channel.send(JSON.stringify({ type: "response.create" }));
          events.push({
            atMs: atMs(),
            type: "client.response.create",
            afterVerifiedContext: true,
          });
        }
      } catch (error) {
        issues.push(`Event parsing: ${redact(error)}`);
      }
    };
    channel.onopen = () => {
      channelOpened = true;
      // Opening the transport is not permission to speak. Only an exact match
      // between actual provider configuration and the server contract allows it.
      events.push({ atMs: atMs(), type: "client.channel_open" });
    };
    channel.onclose = () => {
      channelClosed = true;
      callClosedAt = atMs();
      events.push({
        atMs: atMs(),
        type: "client.data_channel_closed",
        beforeLocalClose: !localClosedAt,
        afterManualStop: !!manualStop,
      });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    aborted();
    callStartedAt = Date.now();
    paidCallAttempts++;
    watchdog = setTimeout(() => {
      hardStop = true;
      issues.push(
        `${hardStopSeconds}-second watchdog requested normal /api/call/end`,
      );
      void endThroughApplication(`${hardStopSeconds}-second hard deadline`);
    }, hardStopSeconds * 1000);
    const realtime = await request(
      "/api/realtime",
      { sdp: offer.sdp, direction: simpleFirstCall ? "incoming" : "outgoing" },
      35000,
    );
    callId = realtime.callId;
    assert.ok(callId, "Application returned call ID");
    assert.equal(
      typeof realtime.contextContract,
      "string",
      "Application returned the expected voice configuration contract",
    );
    expectedContextContract = realtime.contextContract;
    assert.equal(
      JSON.parse(expectedContextContract).length,
      8,
      "Expected canonical eight-field voice contract",
    );
    if (hardStop || interrupted) {
      // A response can arrive after the deadline's unscoped cancellation.
      await request("/api/call/end", { callId }, 16000);
      aborted();
    }
    await pc.setRemoteDescription({ type: "answer", sdp: realtime.sdp });
    sourceTimer = setInterval(() => {
      const frame = new Int16Array(480),
        available = input.subarray(inputOffset, inputOffset + 480);
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
    await until(() => channelOpened, "WebRTC channel", 8000);
    await until(
      () => contextReady,
      "provider session matches expected context contract",
      12000,
    );
    pass(
      "Greeting requested only after provider session exactly matches the server context contract",
    );
    await until(
      () =>
        peak > 300 &&
        events.some((e) => e.type === "output_audio_buffer.stopped"),
      "audible greeting completion",
      12000,
    );
    greeting = events.find(
      (e) => e.type === "response.output_audio_transcript.done",
    )?.transcript;
    assert.ok(greeting, "Actual greeting transcript received");
    assert.match(
      greeting,
      /\bAppy\b/i,
      "Greeting must introduce the chosen agent name",
    );
    if (!simpleFirstCall) {
      assert.match(
        greeting,
        /disagree|conflict|workplace|at work|coworker|colleague/i,
        "Greeting must continue the saved disagreement-at-work topic",
      );
      assert.doesNotMatch(
        greeting,
        /what(?:'s| is) your name|what (?:should|can|do) I call you|what would you like me to call you/i,
        "Greeting must not ask the known user name again",
      );
    }
    configurationEvidence = events
      .filter((e) => e.configuration)
      .map((e) => ({ atMs: e.atMs, type: e.type, ...e.configuration }));
    assert.ok(
      configurationEvidence.some(
        (c) =>
          c.includesAppy &&
          (simpleFirstCall || (c.includesMara && c.includesDisagreement)) &&
          c.tools?.includes("remember"),
      ),
      "Provider confirms named context and memory tools in session configuration",
    );
    pass(
      simpleFirstCall
        ? "Actual provider configuration and audible greeting identify Appy"
        : "Actual provider configuration and audible greeting preserve Appy, Mara and the interview topic",
    );

    if (!simpleFirstCall) {
      const correctionStart = events.length;
      input = correction;
      inputOffset = 0;
      await until(
        () => inputOffset >= input.length,
        "spoken correction delivery",
        correction.length / 48 + 1500,
      );
      await until(
        async () => {
          beforeHangupSession = (await request("/api/session", undefined, 5000))
            .session;
          return (
            beforeHangupSession.profile.userName.value === "Riley" &&
            beforeHangupSession.messages.some(
              (m) =>
                m.channel === "voice" &&
                m.role === "user" &&
                /Riley/i.test(m.text),
            )
          );
        },
        "authenticated spoken correction",
        11000,
        600,
      );
      assert.equal(beforeHangupSession.profile.agentName.value, "Appy");
      assert.equal(
        beforeHangupSession.gmail.status,
        namedSession.gmail.status,
        "Skipped Gmail preference remains unchanged during the call",
      );
      assert.ok(
        beforeHangupSession.messages
          .filter(
            (message) =>
              message.channel === "voice" && message.role === "assistant",
          )
          .every(
            (message) =>
              !/connect.{0,30}gmail|gmail.{0,30}connect|view gmail connection/i.test(
                message.text,
              ),
          ),
        "Voice must not repitch the skipped Gmail connection",
      );
      assert.match(
        beforeHangupSession.profile.goal.value || "",
        /disagree|conflict/i,
      );
      assert.ok(
        events
          .slice(correctionStart)
          .some(
            (e) =>
              e.type ===
                "conversation.item.input_audio_transcription.completed" &&
              /Riley/i.test(e.transcript || ""),
          ),
        "Provider transcribed the actual synthetic correction",
      );
      pass(
        "Spoken correction persisted Riley while retaining Appy and the existing goal",
      );
    }

    await endThroughApplication("normal manual hangup");
    assert.ok(!manualStop.error, manualStop.error);
    clearTimeout(watchdog);
    aborted();
    const endedAt = Date.now();
    localClosedAt = atMs();
    pc.close(); // useVoice closes its local peer after the hangup acknowledgment.
    // Deliberately no settlement sleep. This is the browser's immediate resume.
    const beforeResumeIds = new Set(
      finalSession.messages.map((message) => message.id),
    );
    paidTextAttempts++;
    const resumeRequestedAt = Date.now();
    const resumed = await request(
      "/api/chat",
      { id: randomUUID(), resume: true },
      30000,
    );
    finalSession = resumed.session;
    textResume = {
      requestedAfterHangupAckMs: resumeRequestedAt - endedAt,
      completedAtMs: atMs(),
      lastMessage: finalSession.messages.at(-1),
      generatedReply: finalSession.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.channel === "text" &&
          !beforeResumeIds.has(message.id),
      ),
    };
    if (!simpleFirstCall)
      assert.equal(finalSession.profile.userName.value, "Riley");
    assert.equal(finalSession.profile.agentName.value, "Appy");
    if (!simpleFirstCall)
      assert.match(finalSession.profile.goal.value || "", /disagree|conflict/i);
    assert.equal(finalSession.call.status, "ended");
    if (!textResume.generatedReply) {
      assert.ok(
        typedFollowup,
        "Passive resume returned no assistant message; use the explicit --typed-followup scenario to test context instead",
      );
      pass(
        "Immediate passive resume returns HTTP200 without another assistant message; explicit context check follows",
      );
    } else {
      assert.equal(textResume.lastMessage.role, "assistant");
      assert.equal(textResume.lastMessage.channel, "text");
      assert.doesNotMatch(
        textResume.lastMessage.text,
        /(?:token|usage|spending|demo).{0,30}(?:budget|limit|allowance)|budget.{0,20}(?:exhausted|reached)/i,
      );
      assert.match(
        textResume.lastMessage.text,
        simpleFirstCall
          ? /Appy|name|call|help|chat|message/i
          : /Riley|interview|disagree|conflict|question|work/i,
        "Text continuation must relate to the recent voice conversation",
      );
    }
    if (typedFollowup) {
      const prompt = simpleFirstCall
        ? "What did I name you? Answer in one short sentence."
        : "What's my name, and what exact interview topic are we practicing? Answer in one short sentence.";
      paidTextAttempts++;
      finalSession = (
        await request("/api/chat", { id: randomUUID(), text: prompt }, 30000)
      ).session;
      const reply = finalSession.messages.at(-1);
      explicitTextCheck = { prompt, reply, completedAtMs: atMs() };
      assert.equal(reply.role, "assistant");
      assert.equal(reply.channel, "text");
      if (simpleFirstCall) assert.match(reply.text, /Appy/i);
      else {
        assert.match(
          reply.text,
          /Riley/i,
          "Explicit text reply must recall the spoken name correction",
        );
        assert.match(
          reply.text,
          /disagree|conflict/i,
          "Explicit text reply must recall the saved interview topic",
        );
      }
      assert.doesNotMatch(
        reply.text,
        /(?:token|usage|spending|demo).{0,30}(?:budget|limit|allowance)|budget.{0,20}(?:exhausted|reached)/i,
      );
      pass(
        "One explicitly authorized typed follow-up verifies saved context without a budget error",
      );
    }
    assert.equal(
      events.filter((e) => e.type === "error").length,
      0,
      "No Realtime protocol errors",
    );
    pass(
      "Immediate text resume succeeds without budget error and retains the recent voice context",
    );
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
  if (issues.length) {
    success = false;
    process.exitCode = 1;
  }
  sink?.stop();
  if (pc && localClosedAt === undefined) {
    localClosedAt = atMs();
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
  for (const e of events)
    if (e.type === "response.done" && e.responseId && e.usage)
      uniqueUsage.set(e.responseId, {
        status: e.status,
        statusDetails: e.statusDetails,
        usage: e.usage,
      });
  const report = {
    at: new Date().toISOString(),
    runId,
    base,
    mode: prepareOnly ? "offline-preparation" : "live",
    scenario: simpleFirstCall
      ? "simple-first-incoming-call"
      : "named-context-outgoing-call",
    success,
    durationMs: Date.now() - started,
    paidTextAttempts,
    paidCallAttempts,
    input: { initialText, correctionText },
    prepareEvidence,
    budget: {
      observedLedgerCents,
      globalCapCents,
      voiceMinimumCents,
      testMarginCents,
      authoritativeEnforcement:
        "Existing application shared ledger; no reservation altered or bypassed",
      settlementVerified: false,
      note: "Client events do not prove server settlement; inspect the ledger separately after this test",
    },
    voice: {
      hardStopAtSeconds: hardStopSeconds,
      hardStop,
      callElapsedMs: callStartedAt
        ? (callClosedAt === undefined ? Date.now() : started + callClosedAt) -
          callStartedAt
        : null,
      channelOpened,
      contextReady,
      contextReadyAt,
      expectedContractSha256: expectedContextContract
        ? createHash("sha256").update(expectedContextContract).digest("hex")
        : undefined,
      channelClosedBeforeLocalCleanup: events.some(
        (e) => e.type === "client.data_channel_closed" && e.beforeLocalClose,
      ),
      callClosedAt,
      localClosedAt,
      manualStop,
    },
    audio: {
      receivedBytes: pcm.length,
      peak,
      savedRate: 48000,
      receivedFormats: [...formats],
    },
    googleConsent: { attempted: false, verified: false },
    checks,
    issues,
    greeting,
    configurationEvidence:
      configurationEvidence ||
      events
        .filter((e) => e.configuration)
        .map((e) => ({ atMs: e.atMs, type: e.type, ...e.configuration })),
    textResume,
    explicitTextCheck,
    uniqueResponseUsage: [...uniqueUsage].map(([responseId, data]) => ({
      responseId,
      ...data,
    })),
    transcriptionUsage: events
      .filter(
        (e) =>
          e.type === "conversation.item.input_audio_transcription.completed" &&
          e.usage,
      )
      .map((e) => ({ itemId: e.itemId, usage: e.usage })),
    initialSession,
    namedSession,
    beforeHangupSession,
    finalSession,
    requests,
    events,
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2), {
    flag: "wx",
  });
  console.log(`Report: ${out}/report.json`);
  if (live) setTimeout(() => process.exit(process.exitCode || 0), 500);
}
