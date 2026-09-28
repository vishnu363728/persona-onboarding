/**
 * Real GPT-Live onboarding through the application's authenticated HTTP routes.
 * Offline by default. Never uses a provider key, fabricates OAuth, or edits budget.
 * Live events are continuous streams: transcript groups below are QA heuristics,
 * not provider turn boundaries. Raw deltas/timestamps are retained in the report.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { voiceContextContract, liveOpeningRetryInstruction, LIVE_OPENING_RETRY_DELAY_MS, LIVE_OPENING_RETRY_TIMEOUT_MS } from "../src/lib/voice-contract.ts";
import { normalizeAudio, syntheticSpeech, wavBuffer } from "./voice-audio.mjs";

const args = process.argv.slice(2);
const run = args.includes("--run"), prepare = args.includes("--prepare-only");
const correctionCheck = args.includes("--correction-check");
const option = (key) => args.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
if (args.includes("--help") || (!run && !prepare)) {
  console.log(`GPT-Live real onboarding smoke (no Google consent):
  node scripts/live-onboarding-smoke.mjs --prepare-only
  node scripts/live-onboarding-smoke.mjs <origin> --run --ledger-cents=<fresh-cents> --budget-cents=1000 [--label=live]
  Add --resume-from=<previous-run-folder-name> to retry only the callback/text
  after a saved successful incoming call. Cookie checkpoints are private0600
  files in ignored QA output; never included in the report or console.
  --correction-check requires --resume-from and checks a spoken Riley correction
  for one acknowledgment/question before normal hangup and typed context recall.

Two sequential calls, no paid retries: name Appy in text; incoming voice collects
Mara, explains the experience, practices a workplace interview, offers Gmail,
respects its refusal, and remembers a Thursday/job-change tangent. Public hangup
must finalize session.closed. A user-initiated callback recalls the tangent,
then one explicit typed follow-up checks name, Thursday, and why Mara left work.
Incoming call has a180s safety stop; callback60s. These are QA safety deadlines,
not application call limits. Both stops use /api/call/end and keep media alive.
Preflight requires fresh ledger +51c minimum +20c margin within explicit cap.
Shared application ledger remains authoritative; unknown holds remain untouched.
--prepare-only synthesizes local PCM and creates an offline SDP, with no network.
Reports/audio: output/qa/live-onboarding/<unique-label-time-UUID>/`);
  process.exit(0);
}
assert.notEqual(run, prepare, "Choose exactly one execution mode");
for (const a of args.filter((v) => v.startsWith("--")))
  assert.match(a, /^(--run|--prepare-only|--correction-check|--label=[a-z0-9][a-z0-9-]{0,31}|--ledger-cents=\d+(?:\.\d+)?|--budget-cents=(?:500|1000)|--resume-from=[a-z0-9][A-Za-z0-9-]{5,120})$/, "Unknown option");
const resumeFrom = option("resume-from");
assert.ok(!resumeFrom || run, "Resume is available only in explicitly paid mode");
assert.ok(!correctionCheck || resumeFrom, "Correction check requires the exact existing session");
const targets = args.filter((v) => !v.startsWith("--"));
assert.ok(targets.length <= 1);
const target = new URL(targets[0] || "http://127.0.0.1:4317");
assert.ok(["https:", "http:"].includes(target.protocol));
assert.ok(!target.username && !target.password && !target.hash && !target.search);
assert.equal(target.pathname, "/");
const base = target.origin;
const observedLedgerCents = option("ledger-cents") === undefined ? null : Number(option("ledger-cents"));
const capCents = Number(option("budget-cents") || 500);
if (run) {
  assert.ok(Number.isFinite(observedLedgerCents) && observedLedgerCents >= 0, "Supply the fresh shared ledger amount");
  assert.ok(observedLedgerCents + 51 + 20 <= capCents, "Insufficient budget headroom; preserve existing holds");
}
const started = Date.now();
const label = option("label") || (prepare ? "prepared" : "live");
const runId = `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const out = `output/qa/live-onboarding/${runId}`;
await mkdir("output/qa/live-onboarding", { recursive: true });
await mkdir(out);
const atMs = () => Date.now() - started;
const redact = (e) => String(e instanceof Error ? e.message : e).replace(/sk-[\w-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1200);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const checks = [], issues = [], requests = [], calls = [], snapshots = [], speech = {};
let cookie = "", cookieCheckpoint = false, active, success = false, interrupted = false, initialSession, finalSession, textCheck;
let paidTextAttempts = 0, paidCallAttempts = 0;
function pass(name) { checks.push(name); console.log("PASS", name); }
async function checkpointCookie() {
  if (cookieCheckpoint || !cookie) return;
  await writeFile(`${out}/private-session.json`, JSON.stringify({ origin: base, cookie }), { flag: "wx", mode: 0o600 });
  cookieCheckpoint = true;
}
async function request(path, body, timeout = 15000) {
  const log = { atMs: atMs(), path, method: body === undefined ? "GET" : "POST" };
  requests.push(log);
  const response = await fetch(base + path, {
    method: log.method,
    headers: { origin: base, cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  log.status = response.status;
  log.completedAtMs = atMs();
  const next = response.headers.get("set-cookie");
  if (next) { cookie = next.split(";")[0]; await checkpointCookie(); }
  const data = await response.json();
  if (!response.ok) { log.error = redact(data.error || `HTTP ${response.status}`); log.code = data.code; }
  assert.equal(response.status, 200, `${path}: ${log.error || response.status}`);
  return data;
}
async function session(label) {
  const value = (await request("/api/session")).session;
  snapshots.push({ atMs: atMs(), label, session: value });
  return value;
}
async function wait(check, description, timeout, call, interval = 100) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (interrupted) throw new Error("Interrupted");
    if (call?.hardStop) throw new Error(`${call.name} QA deadline reached`);
    if (await check()) return;
    if (call?.closed && !description.includes("finalization")) throw new Error(`${call.name} closed before ${description}`);
    await delay(interval);
  }
  throw new Error(`Timed out: ${description}`);
}
function metadata(s, expected) {
  const contract = voiceContextContract(s || {}), instructions = s?.instructions || "";
  return {
    model: s?.model, voice: s?.audio?.output?.voice,
    delegationType: s?.delegation?.type || "client",
    contractSha256: hash(contract), exactContractMatch: contract === expected,
    instructionSha256: hash(instructions), instructionCharacters: instructions.length,
    inputMessages: s?.input?.length, containsAppy: /\bAppy\b/i.test(contract),
    containsMara: /\bMara\b/i.test(contract), containsThursday: /Thursday/i.test(contract),
  };
}
function transcript(call, role, startIndex = 0) {
  return call.events.slice(startIndex).filter((e) => e.type === `session.${role}_transcript.delta`).map((e) => e.delta).join("");
}
function hasGmailControlGuidance(text) {
  const location = /view\s+gmail|gmail.{0,25}(?:card|button|in (?:messages|chat))|(?:card|button).{0,25}gmail/i.test(text);
  const action = /(?:tap|click|choose|select|open|use).{0,80}(?:gmail|connect)/i.test(text);
  return location && action && /connect/i.test(text);
}
function groupedTranscripts(events) {
  const groups = [];
  for (const role of ["input", "output"]) {
    let group;
    for (const e of events.filter((v) => v.type === `session.${role}_transcript.delta`)) {
      const time = typeof e.start_ms === "number" ? e.start_ms : e.atMs;
      const previousEnd = group?.end_ms ?? group?.lastAtMs;
      if (!group || time - previousEnd > 1200) {
        group = { role, text: "", start_ms: e.start_ms, end_ms: e.end_ms, firstAtMs: e.atMs, lastAtMs: e.atMs };
        groups.push(group);
      }
      group.text += e.delta; // Preserve spaces/repeated words exactly.
      group.end_ms = e.end_ms;
      group.lastAtMs = e.atMs;
    }
  }
  return groups.sort((a, b) => a.firstAtMs - b.firstAtMs);
}
const { default: wrtc } = await import("@roamhq/wrtc");
async function createPeer(name, direction, hardSeconds) {
  const c = { name, direction, hardSeconds, events: [], received: [], formats: new Set(), peak: 0,
    input: new Int16Array(), offset: 0, ready: false, closed: false, hardStop: false, speechWindows: [] };
  c.pc = new wrtc.RTCPeerConnection();
  c.source = new wrtc.nonstandard.RTCAudioSource();
  c.track = c.source.createTrack();
  c.track.enabled = false;
  c.pc.addTrack(c.track, new wrtc.MediaStream([c.track]));
  c.pc.onconnectionstatechange = () => c.events.push({ atMs: atMs(), type: "client.connection_state", state: c.pc.connectionState });
  c.pc.ontrack = ({ track }) => {
    c.sink = new wrtc.nonstandard.RTCAudioSink(track);
    c.sink.ondata = (data) => {
      if (data.bitsPerSample !== 16) return;
      let peak = 0;
      for (const n of data.samples) peak = Math.max(peak, Math.abs(n));
      c.peak = Math.max(c.peak, peak);
      if (peak > 350) c.lastAudibleAt = Date.now();
      c.received.push(normalizeAudio(data, c.formats));
    };
  };
  c.channel = c.pc.createDataChannel("oai-events");
  c.channel.onopen = () => c.events.push({ atMs: atMs(), type: "client.channel_open" });
  c.channel.onclose = () => {
    c.closed = true;
    c.events.push({ atMs: atMs(), type: "client.channel_closed", beforeLocalCleanup: !c.localClosedAt });
  };
  c.channel.onmessage = ({ data }) => {
    try {
      const event = JSON.parse(data), e = { atMs: atMs(), type: event.type };
      for (const key of ["event_id", "delta", "start_ms", "end_ms", "offset_ms", "usage", "reason", "client_event_id", "delegation_id"])
        if (event[key] !== undefined) e[key] = event[key];
      if (event.delegation) e.delegation = { id: event.delegation.id, type: event.delegation.type, target: event.delegation.target };
      if (["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type) && event.delta?.trim()) {
        c.heardSpeech = true;
        clearTimeout(c.openingRetryTimer);
        clearTimeout(c.openingFailureTimer);
      }
      if (event.type === "session.output_transcript.delta") c.lastOutputAt = Date.now();
      if (event.error) {
        e.error = { code: event.error.code, message: redact(event.error.message) };
        e.nonfatalCompactionWarning = event.error.code === "missing_scope" &&
          /history compaction is disabled/i.test(event.error.message || "") &&
          /session will continue/i.test(event.error.message || "");
      }
      if (event.type === "response.event") {
        const nested = event.event || event.response_event || {};
        e.nestedType = nested.type;
        if (nested.response?.usage) e.delegatedUsage = nested.response.usage;
      }
      if (event.session && ["session.started", "session.updated", "session.closed"].includes(event.type))
        e.configuration = metadata(event.session, c.contract);
      c.events.push(e);
      if (event.type === "session.closed") {
        c.finalization = { atMs: atMs(), usage: event.usage, reason: event.reason };
        return;
      }
      if (event.type === "session.started" && !c.ready && !c.endTask && !c.hardStop) {
        assert.equal(event.session?.id, c.id, "Live session ID matches authenticated application call ID");
        assert.equal(e.configuration?.exactContractMatch, true, "Actual provider Live configuration matches the app contract");
        assert.equal(event.session?.model, "gpt-live-1");
        c.ready = true;
        c.track.enabled = true;
        const opener = { type: "session.instructions.append", event_id: `persona_greeting_${randomUUID()}`, delegation_id: null,
          content: c.openingInstruction };
        c.greetingEventId = opener.event_id;
        c.channel.send(JSON.stringify(opener));
        c.events.push({ atMs: atMs(), type: "client.greeting_sent", verifiedSession: true });
        c.openingRetryTimer = setTimeout(() => {
          if (c.heardSpeech || c.endTask || c.closed || c.channel.readyState !== "open") return;
          const retry = { type: "session.instructions.append", event_id: `persona_greeting_retry_${randomUUID()}`, delegation_id: null,
            content: liveOpeningRetryInstruction(c.openingInstruction) };
          c.channel.send(JSON.stringify(retry));
          c.events.push({ atMs: atMs(), type: "client.greeting_retry_sent", noInputOrOutputSpeech: true });
          c.openingFailureTimer = setTimeout(() => {
            if (c.heardSpeech || c.endTask || c.closed) return;
            c.eventError = "Live opening remained silent after one bounded retry";
            void endCall(c, "opening silence fallback");
          }, LIVE_OPENING_RETRY_TIMEOUT_MS);
        }, LIVE_OPENING_RETRY_DELAY_MS);
      }
    } catch (e) { c.eventError = redact(e); }
  };
  await c.pc.setLocalDescription(await c.pc.createOffer());
  await wait(() => c.pc.iceGatheringState === "complete", "offline ICE gathering", 10000);
  assert.ok(c.pc.localDescription?.sdp);
  c.sdp = c.pc.localDescription.sdp;
  return c;
}
async function connect(c) {
  active = c;
  calls.push(c);
  paidCallAttempts++;
  c.attemptStartedAtMs = atMs();
  c.watchdog = setTimeout(() => {
    c.hardStop = true;
    void endCall(c, "QA hard deadline");
  }, c.hardSeconds * 1000);
  const data = await request("/api/realtime", { sdp: c.sdp, direction: c.direction }, 45000);
  c.id = data.callId;
  c.contract = data.contextContract;
  assert.ok(typeof data.openingInstruction === "string" && data.openingInstruction.length > 0 && data.openingInstruction.length < 3000,
    "Application supplies a bounded concrete opening instruction");
  c.openingInstruction = data.openingInstruction;
  assert.ok(c.id && typeof c.contract === "string");
  c.expectedContractSha256 = hash(c.contract);
  if (c.hardStop || interrupted) { await request("/api/call/end", { callId: c.id }, 30000); throw new Error("Creation completed after cancellation"); }
  await c.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
  c.sourceTimer = setInterval(() => {
    const frame = new Int16Array(480), available = c.input.subarray(c.offset, c.offset + 480);
    frame.set(available); c.offset += available.length;
    c.source.onData({ samples: frame, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
  }, 10);
  await wait(() => { if (c.eventError) throw new Error(c.eventError); return c.ready; }, "verified session.started", 15000, c);
  pass(`${c.name}: gpt-live-1 session.started exactly matches context before microphone/greeting`);
}
async function quietOutput(c, from, description, timeout = 24000) {
  await wait(() => transcript(c, "output", from).trim().length > 8 && c.peak > 350 &&
    Date.now() - (c.lastOutputAt || Date.now()) > 1000 && Date.now() - (c.lastAudibleAt || Date.now()) > 900,
  `${description} (transcript + received-audio quiet window)`, timeout, c);
  const text = transcript(c, "output", from);
  console.log(`${c.name} ${description}: ${text}`);
  return text;
}
async function speak(c, key, respond = true) {
  const firstEvent = c.events.length;
  const window = { key, text: utterances[key], startedAtMs: atMs(), firstEvent };
  c.speechWindows.push(window);
  c.input = speech[key]; c.offset = 0;
  await wait(() => c.offset >= c.input.length, `speech delivery ${key}`, c.input.length / 48 + 2500, c);
  c.input = new Int16Array(); c.offset = 0;
  window.deliveredAtMs = atMs();
  await wait(() => transcript(c, "input", firstEvent).trim().length > 3, `actual input transcript ${key}`, 8000, c);
  if (respond) window.reply = await quietOutput(c, firstEvent, `reply to ${key}`);
  window.inputTranscript = transcript(c, "input", firstEvent);
  window.completedAtMs = atMs();
  return window;
}
async function endCall(c, reason) {
  if (c.endTask) return c.endTask;
  c.stop = { reason, requestedAtMs: atMs() };
  clearTimeout(c.openingRetryTimer); clearTimeout(c.openingFailureTimer);
  c.input = new Int16Array(); c.offset = 0;
  c.track.enabled = false; // Continue sending silence until finalization, matching browser.
  c.endTask = (async () => {
    // Never send an unscoped cleanup for a handshake that has not returned an ID.
    if (!c.id) return;
    try {
      const stats = await c.pc.getStats();
      c.transportStats = [...stats.values()].filter((s) => ["outbound-rtp", "inbound-rtp", "media-source"].includes(s.type)).map((s) => {
        const value = { type: s.type };
        for (const key of ["kind", "mediaType", "packetsSent", "bytesSent", "packetsReceived", "bytesReceived", "totalSamplesDuration", "totalAudioEnergy", "audioLevel"])
          if (s[key] !== undefined) value[key] = s[key];
        return value;
      });
    } catch { /* Stats are diagnostic only; hangup must still proceed. */ }
    const data = await request("/api/call/end", { callId: c.id }, 30000);
    c.stop.acknowledgedAtMs = atMs();
    c.endedSession = data.session;
    finalSession = data.session;
    const deadline = Date.now() + 3000;
    while (!c.finalization && !c.closed && Date.now() < deadline) await delay(50);
    c.stop.finalizationObserved = !!c.finalization;
  })().catch((e) => { c.stop.error = redact(e); }).finally(() => {
    clearTimeout(c.watchdog); clearInterval(c.sourceTimer);
    c.localClosedAt = atMs(); c.track.stop(); c.sink?.stop(); c.pc.close();
    if (active === c) active = undefined;
  });
  return c.endTask;
}
const interrupt = () => { interrupted = true; if (active) void endCall(active, "process signal"); };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
const utterances = {
  name: "I'm Mara.",
  how: "Before we get started, how does this work?",
  goal: "I want to practice an interview question about a disagreement with my manager at work.",
  gmail: "Thanks, anything else to set up?",
  skip: "Actually, skip Gmail. I would rather keep practicing here.",
  tangent: "Quick tangent: my interview is on Thursday, and I am nervous about explaining why I left my last job.",
  recall: "What day is my interview, and what was I just nervous about?",
  diagnostic: "Hello, are you there?",
  correction: "Actually, call me Riley instead.",
};
try {
  for (const [key, words] of Object.entries(utterances)) speech[key] = await syntheticSpeech(out, `user-${key}`, words);
  if (prepare) {
    const peer = await createPeer("offline", "incoming", 180);
    const evidence = { sdpBytes: peer.sdp.length, iceComplete: peer.pc.iceGatheringState === "complete", hasAudio: peer.sdp.includes("m=audio"), hasDataChannel: peer.sdp.includes("m=application") };
    peer.track.stop(); peer.pc.close();
    await writeFile(`${out}/offline-peer.json`, JSON.stringify(evidence, null, 2), { flag: "wx" });
    pass("Local speech and offline SDP prepared with zero application/provider requests");
    success = true;
  } else {
    if (resumeFrom) {
      const previous = `output/qa/live-onboarding/${resumeFrom}`;
      const saved = JSON.parse(await readFile(`${previous}/private-session.json`, "utf8"));
      const evidence = JSON.parse(await readFile(`${previous}/report.json`, "utf8"));
      assert.equal(saved.origin, base, "Resume cookie belongs to this origin");
      assert.match(saved.cookie, /^persona_session=[a-f0-9]{64}$/);
      assert.ok(evidence.snapshots?.some((s) => s.label === "after-incoming-hangup"), "Only resume a completed incoming onboarding flow");
      cookie = saved.cookie;
      await checkpointCookie();
      initialSession = await session("resumed-authenticated-session");
      assert.equal(initialSession.call.status, "ended");
      assert.equal(initialSession.profile.agentName.value, "Appy");
      assert.equal(initialSession.profile.userName.value, "Mara");
      assert.ok(["deferred", "declined"].includes(initialSession.gmail.status));
      assert.ok(initialSession.messages.some((m) => m.role === "user" && m.channel === "voice" && /Thursday/i.test(m.text)));
      pass("Resumed exact authenticated synthetic session with saved incoming voice history");
    } else {
    const first = await request("/api/session"); initialSession = first.session;
    assert.ok(cookie && first.capabilities.voice);
    assert.equal(initialSession.profile.agentName.value, null);
    paidTextAttempts++;
    const named = (await request("/api/chat", { id: randomUUID(), text: "Call yourself Appy." }, 30000)).session;
    assert.equal(named.profile.agentName.value, "Appy");
    assert.equal(named.call.status, "ringing");
    snapshots.push({ atMs: atMs(), label: "named-and-incoming", session: named });
    const incoming = await createPeer("incoming-onboarding", "incoming", 180);
    await connect(incoming);
    try {
      incoming.greeting = await quietOutput(incoming, 0, "greeting");
    } catch (greetingError) {
      incoming.greetingFailure = redact(greetingError);
      // Authorized one-shot diagnostic within this SAME call. Never converts a
      // failed opening into a pass or starts another paid provider session.
      if (incoming.ready && !incoming.closed && !incoming.hardStop) {
        const from = incoming.events.length;
        incoming.diagnostic = { text: utterances.diagnostic, firstEvent: from };
        try {
          await speak(incoming, "diagnostic", false);
          incoming.diagnostic.reply = await quietOutput(incoming, from, "diagnostic response", 10000);
        } catch (e) { incoming.diagnostic.error = redact(e); }
        incoming.diagnostic.inputTranscript = transcript(incoming, "input", from);
        incoming.diagnostic.outputTranscript = transcript(incoming, "output", from);
        console.log("GREETING FAILURE DIAGNOSTIC", JSON.stringify(incoming.diagnostic));
      }
      throw greetingError;
    }
    assert.match(incoming.greeting, /\bAppy\b/i);
    assert.match(incoming.greeting, /name|call you/i, "First incoming greeting asks the unknown user name");
    await speak(incoming, "name");
    await wait(async () => (await session("await-name")).profile.userName.value === "Mara", "saved spoken Mara", 10000, incoming, 800);
    await speak(incoming, "how");
    await speak(incoming, "goal");
    await wait(async () => /disagree|conflict/i.test((await session("await-goal")).profile.goal.value || ""), "saved spoken interview goal", 10000, incoming, 800);
    const beforeGmail = await session("before-gmail");
    incoming.gmailOffer = { offeredImmediatelyAfterGoal: beforeGmail.gmail.status === "offered", neutralBridgeUsed: beforeGmail.gmail.status !== "offered" };
    if (beforeGmail.gmail.status !== "offered") await speak(incoming, "gmail");
    await wait(async () => (await session("await-gmail-card")).gmail.status === "offered", "authenticated offered Gmail card", 12000, incoming, 800);
    await wait(() => hasGmailControlGuidance(transcript(incoming, "output")),
      "spoken guidance locates the actual Gmail card and explains the connect action", 8000, incoming);
    await wait(() => Date.now() - (incoming.lastOutputAt || Date.now()) > 1000 && Date.now() - (incoming.lastAudibleAt || Date.now()) > 900,
      "Gmail control announcement reaches its normal audio quiet window", 24000, incoming);
    incoming.gmailOffer.spokenGuidance = groupedTranscripts(incoming.events).filter((g) => g.role === "output" && /gmail/i.test(g.text)).map((g) => g.text).join(" ");
    console.log("GMAIL CARD GUIDANCE", incoming.gmailOffer.spokenGuidance);
    pass("Incoming voice saved Mara and interview goal, and proactively offered an actual Gmail card without an explicit Gmail request");
    await speak(incoming, "skip");
    await wait(async () => ["deferred", "declined"].includes((await session("await-gmail-decline")).gmail.status), "spoken Gmail refusal persisted", 10000, incoming, 800);
    const tangent = await speak(incoming, "tangent");
    assert.match(tangent.inputTranscript, /Thursday/i);
    await endCall(incoming, "normal manual hangup after tangent");
    assert.ok(!incoming.stop.error, incoming.stop.error);
    assert.ok(incoming.finalization, "Incoming call emits session.closed before local cleanup");
    assert.ok(Number.isFinite(incoming.finalization.usage?.seconds), "Incoming final usage confirmed");
    const after = await session("after-incoming-hangup");
    assert.equal(after.call.status, "ended");
    assert.equal(after.profile.userName.value, "Mara");
    assert.ok(after.messages.some((m) => m.role === "user" && m.channel === "voice" && /Thursday/i.test(m.text)), "Final tangent saved through public hangup");
    pass("Incoming hangup confirms final Live usage and preserves the latest spoken tangent");
    }
    const callback = await createPeer("outgoing-callback", "outgoing", 60);
    await connect(callback);
    callback.greeting = await quietOutput(callback, 0, "callback greeting");
    assert.doesNotMatch(callback.greeting, /what(?:'s| is) your name|what (?:should|can|do) I call you|what would you like me to call you/i);
    assert.doesNotMatch(callback.greeting, /connect.{0,30}gmail|gmail.{0,30}connect/i);
    if (correctionCheck) {
      const correction = await speak(callback, "correction");
      await wait(async () => (await session("await-corrected-name")).profile.userName.value === "Riley", "saved corrected name Riley", 10000, callback, 800);
      // Observe the ordinary delayed backend completion too: a premature first
      // quiet gap must not hide a duplicate acknowledgment a moment later.
      await delay(2500);
      await wait(() => Date.now() - callback.lastOutputAt > 1000 && Date.now() - callback.lastAudibleAt > 900,
        "correction response and delayed backend output finish", 12000, callback);
      correction.reply = transcript(callback, "output", correction.firstEvent);
      callback.correction = { ...correction, expectedName: "Riley", questionCount: (correction.reply.match(/\?/g) || []).length,
        nameMentionCount: (correction.reply.match(/\bRiley\b/gi) || []).length };
      assert.match(correction.reply, /\bRiley\b/i);
      assert.ok(callback.correction.questionCount <= 1, "Correction must not repeat its follow-up question");
      assert.equal(callback.correction.nameMentionCount, 1, "Correction acknowledges the new name once");
      assert.doesNotMatch(correction.reply, /(?:connect|view).{0,30}gmail|what(?:'s| is) your name/i);
      console.log("CORRECTION DEDUP CHECK", correction.reply);
      await endCall(callback, "normal hangup after one corrected-name acknowledgment");
    } else {
    const recall = await speak(callback, "recall", false);
    await wait(() => {
      const value = transcript(callback, "output", recall.firstEvent);
      return /Thursday/i.test(value) && /(?:left|leav(?:ing|e)).{0,45}(?:job|work)|(?:last|previous)\s+job/i.test(value) &&
        Date.now() - (callback.lastAudibleAt || 0) < 400;
    }, "callback recalls tangent while actual output audio is active", 22000, callback);
    recall.reply = transcript(callback, "output", recall.firstEvent);
    callback.outputInterruption = { atMs: atMs(), lastAudibleMsAgo: Date.now() - callback.lastAudibleAt,
      lastTranscriptMsAgo: Date.now() - callback.lastOutputAt, waitedForQuietWindow: false,
      note: "Hangup requested while received non-silent audio was observed in the previous400ms; Live has no turn-completion event" };
    console.log("CALLBACK RECALL BEFORE ACTIVE-AUDIO HANGUP", recall.reply);
    assert.match(recall.reply, /Thursday/i, "Callback remembers interview day");
    assert.match(recall.reply, /left|leav|leaving|last job|previous job/i, "Callback remembers latest tangent rather than only profile goal");
    await endCall(callback, "user hangs up during callback output before text");
    }
    assert.ok(!callback.stop.error, callback.stop.error);
    assert.ok(callback.finalization && Number.isFinite(callback.finalization.usage?.seconds), "Callback final usage confirmed");
    const text = "What is my name, when is my interview, and what was I nervous about explaining? Answer in one short sentence.";
    paidTextAttempts++;
    const requestedAtMs = atMs();
    finalSession = (await request("/api/chat", { id: randomUUID(), text }, 30000)).session;
    const reply = finalSession.messages.at(-1);
    textCheck = { text, reply, requestedAtMs, afterHangupAckMs: requestedAtMs - callback.stop.acknowledgedAtMs };
    assert.equal(reply.role, "assistant");
    assert.equal(reply.channel, "text");
    assert.match(reply.text, correctionCheck ? /Riley/i : /Mara/i); assert.match(reply.text, /Thursday/i);
    assert.match(reply.text, /left|leav|leaving|last job|previous job/i);
    assert.equal(finalSession.profile.agentName.value, "Appy");
    assert.equal(finalSession.profile.userName.value, correctionCheck ? "Riley" : "Mara");
    assert.ok(["deferred", "declined"].includes(finalSession.gmail.status));
    assert.equal(finalSession.call.status, "ended");
    for (const c of calls) {
      assert.ok(!c.eventError, c.eventError);
      assert.ok(!c.hardStop, "Scenario finishes before QA deadline");
      assert.equal(c.events.filter((e) => (e.type === "error" || e.error) && !e.nonfatalCompactionWarning).length, 0, "No fatal Live protocol errors; any explicit compaction-only warning remains recorded");
    }
    pass(correctionCheck ? "Single spoken Riley correction persists; immediate Together text retains Riley, Thursday, and job-change tangent" : "Outgoing callback and immediate Together text both recall Mara, Thursday, and the latest job-change tangent");
    console.log("TEXT RECALL", reply.text);
    success = true;
  }
} catch (e) {
  issues.push(redact(e)); console.error("FAIL", issues.at(-1)); process.exitCode = 1;
} finally {
  if (active) await endCall(active, "failure cleanup");
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  const reports = [];
  for (const c of calls) {
    const pcm = Buffer.concat(c.received);
    if (pcm.length) await writeFile(`${out}/${c.name}-received.wav`, wavBuffer(pcm, { rate: 48000, channels: 1 }), { flag: "wx" });
    reports.push({ name: c.name, direction: c.direction, callId: c.id, ready: c.ready, expectedContractSha256: c.expectedContractSha256,
      hardStopSeconds: c.hardSeconds, hardStop: c.hardStop, attemptStartedAtMs: c.attemptStartedAtMs,
      localClosedAt: c.localClosedAt, stop: c.stop, finalization: c.finalization, eventError: c.eventError,
      openingInstruction: c.openingInstruction, greeting: c.greeting, greetingFailure: c.greetingFailure, diagnostic: c.diagnostic, gmailOffer: c.gmailOffer, outputInterruption: c.outputInterruption, correction: c.correction,
      speechWindows: c.speechWindows, transcriptGroups: groupedTranscripts(c.events),
      transcriptGrouping: "Heuristic same-role timeline gaps >1200ms; not provider turn-completion events",
      audio: { receivedBytes: pcm.length, peak: c.peak, normalizedRate: 48000, formats: [...c.formats] }, transportStats: c.transportStats, events: c.events });
  }
  await writeFile(`${out}/report.json`, JSON.stringify({ runId, mode: prepare ? "offline-preparation" : "actual-gpt-live", success,
    at: new Date().toISOString(), durationMs: Date.now() - started, base, resumeFrom, correctionCheck, paidCallAttempts, paidTextAttempts,
    budget: { observedLedgerCents, capCents, minimumVoiceReserveCents: 51, marginCents: 20, authoritativeEnforcement: "Application shared ledger; no holds changed", settlementVerified: false, note: "Final provider usage is recorded; inspect server ledger/receipts separately for settlement" },
    googleConsent: { attempted: false, verified: false, note: "Only offered card and spoken refusal tested" },
    sources: ["https://developers.openai.com/api/docs/guides/live-conversations", "https://developers.openai.com/api/docs/guides/voice-webrtc?api=live"],
    preparedSpeech: Object.entries(utterances).map(([key, text]) => ({ key, text, seconds: speech[key]?.length / 48000 })),
    checks, issues, requests, calls: reports, snapshots, initialSession, finalSession, textCheck }, null, 2), { flag: "wx" });
  console.log("REPORT", `${out}/report.json`);
  // Native wrtc threads can outlive closed transports. All evidence is flushed.
  setTimeout(() => process.exit(success ? 0 : 1), 500);
}
