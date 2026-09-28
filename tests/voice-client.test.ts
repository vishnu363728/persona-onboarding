import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { useVoice } from "../src/components/use-voice";
import type { PublicSession } from "../src/lib/domain";
import { voiceContextContract } from "../src/lib/voice-contract";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const providerConfiguration = {
  model: "gpt-realtime-2.1",
  instructions:
    "You are Appy. Help Mara practice a disagreement-at-work interview question.",
  tools: [{ name: "remember" }, { name: "offer_gmail" }, { name: "end_call" }],
  audio: {
    output: { voice: "marin" },
    input: {
      transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: { type: "semantic_vad" },
    },
  },
  output_modalities: ["audio"],
  max_output_tokens: 600,
};
const contextContract = voiceContextContract(providerConfiguration);
const liveConfiguration = {
  model: "gpt-live-1",
  instructions:
    "You are Appy. Continue helping Riley track their week. Gmail was skipped.",
  input: [
    { role: "user", content: [{ type: "input_text", text: "I'm Riley." }] },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "Nice to meet you, Riley." }],
    },
  ],
  delegation: { type: "client" },
  audio: { output: { voice: "marin" } },
};
function fixture(
  configuration: Parameters<
    typeof voiceContextContract
  >[0] = providerConfiguration,
) {
  const expectedContract = voiceContextContract(configuration);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const sessions: unknown[] = [],
    errors: string[] = [];
  let blockedPlayback = false,
    playbackAttempts = 0;
  let resumed = 0,
    micRequests = 0;
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let microphone = () => Promise.resolve(stream);
  let offer = () => Promise.resolve({ sdp: "offer" });
  let remoteDescription = () => Promise.resolve();
  const api: Record<string, () => Promise<unknown>> = {};
  const statuses: Record<string, number> = {};
  const peers: Peer[] = [];
  const audios: Audio[] = [];
  const beacons: unknown[] = [];
  class Channel {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
    open(verified = true) {
      this.onopen?.();
      if (verified)
        this.emit({
          type:
            configuration.model === "gpt-live-1"
              ? "session.started"
              : "session.updated",
          session: {
            ...configuration,
            id:
              peers.findIndex((peer) => peer.channel === this) === 0
                ? "call-one"
                : `call-${peers.findIndex((peer) => peer.channel === this) + 1}`,
          },
        });
    }
    close() {
      this.onclose?.();
    }
    emit(event: unknown) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }
  let pc!: Peer;
  class Peer {
    connectionState = "new";
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
    channel = new Channel();
    remote: unknown;
    constructor() {
      pc = this;
      peers.push(this);
    }
    tracks: unknown[] = [];
    addTrack(track: unknown) {
      this.tracks.push(track);
    }
    createDataChannel() {
      return this.channel;
    }
    createOffer() {
      return offer();
    }
    setLocalDescription() {
      return Promise.resolve();
    }
    setRemoteDescription(answer: unknown) {
      this.remote = answer;
      return remoteDescription();
    }
    close() {
      this.connectionState = "closed";
      this.onconnectionstatechange?.();
    }
  }
  class Audio {
    constructor() {
      audios.push(this);
    }
    autoplay = false;
    muted = false;
    srcObject: unknown = null;
    play() {
      playbackAttempts++;
      if (blockedPlayback)
        return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      return Promise.resolve();
    }
    pause() {}
  }
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    navigator: {
      mediaDevices: {
        getUserMedia: () => {
          micRequests++;
          return microphone();
        },
      },
      sendBeacon: (path: string, body: Blob) => {
        beacons.push({ path, body });
        return true;
      },
    },
    window: new EventTarget(),
    RTCPeerConnection: Peer,
    Audio,
    fetch: async (path: string, init: { body?: string } = {}) => {
      requests.push({ path, body: JSON.parse(init.body || "{}") });
      const body = api[path]
        ? await api[path]()
        : path === "/api/realtime"
          ? {
              callId: "call-one",
              sdp: "answer",
              renewAfterSeconds: 660,
              contextContract: expectedContract,
              session: { revision: 1 },
            }
          : path === "/api/realtime/renew"
            ? {
                callId: `call-${peers.length}`,
                sdp: "renewed-answer",
                renewAfterSeconds: 660,
                contextContract: expectedContract,
                session: { revision: peers.length },
              }
            : { session: { revision: 2 } };
      return { ok: (statuses[path] || 200) < 400, json: async () => body };
    },
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const hooks: unknown[] = [],
    cleanup: (() => void)[] = [];
  let cursor = 0;
  const callbacks = {
    onSession: (s: PublicSession) => sessions.push(s),
    onError: (s: string) => errors.push(s),
    onEnded: () => {
      resumed++;
    },
  };
  function render() {
    cursor = 0;
    const originals = {
      useRef: React.useRef,
      useState: React.useState,
      useEffect: React.useEffect,
      useCallback: React.useCallback,
    };
    Object.assign(React, {
      useRef: (initial: unknown) => {
        const i = cursor++;
        return (hooks[i] ??= { current: initial });
      },
      useState: (initial: unknown) => {
        const i = cursor++;
        if (!(i in hooks)) hooks[i] = initial;
        return [
          hooks[i],
          (value: unknown) => {
            hooks[i] =
              typeof value === "function"
                ? (value as (old: unknown) => unknown)(hooks[i])
                : value;
          },
        ];
      },
      useCallback: (fn: unknown) => fn,
      useEffect: (fn: () => void | (() => void)) => {
        const i = cursor++;
        if (!(i in hooks)) {
          hooks[i] = true;
          const dispose = fn();
          if (dispose) cleanup.push(dispose);
        }
      },
    });
    try {
      return useVoice(callbacks);
    } finally {
      Object.assign(React, originals);
    }
  }
  return {
    render,
    requests,
    sessions,
    errors,
    stream,
    track,
    api,
    statuses,
    peers,
    audios,
    beacons,
    unmount() {
      cleanup.splice(0).forEach((fn) => fn());
    },
    get pc() {
      return pc;
    },
    get resumed() {
      return resumed;
    },
    get micRequests() {
      return micRequests;
    },
    microphone(fn: typeof microphone) {
      microphone = fn;
    },
    blockPlayback(blocked: boolean) {
      blockedPlayback = blocked;
    },
    get playbackAttempts() {
      return playbackAttempts;
    },
    offer(fn: typeof offer) {
      offer = fn;
    },
    remoteDescription(fn: typeof remoteDescription) {
      remoteDescription = fn;
    },
    dispose() {
      cleanup.forEach((fn) => fn());
      for (const [key, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("only an exact provider context match enables microphone and one greeting", async () => {
  for (const type of ["session.created", "session.updated"]) {
    const f = fixture();
    try {
      await f.render().start("outgoing");
      f.pc.channel.open(false);
      assert.equal(f.track.enabled, false);
      assert.equal(f.pc.channel.sent.length, 0);
      assert.equal(f.render().state, "connecting");
      for (const session of [
        {},
        {
          ...providerConfiguration,
          instructions: "You are a default assistant",
        },
        {
          ...providerConfiguration,
          instructions: providerConfiguration.instructions + " Stale context",
        },
        { ...providerConfiguration, model: "gpt-realtime" },
        { ...providerConfiguration, tools: [] },
      ]) {
        f.pc.channel.emit({ type, session });
        assert.equal(
          f.track.enabled,
          false,
          "wrong configuration keeps microphone disabled",
        );
        assert.equal(
          f.pc.channel.sent.length,
          0,
          "wrong configuration cannot generate a greeting",
        );
      }
      f.render().toggleMute();
      f.render().toggleMute();
      assert.equal(
        f.track.enabled,
        false,
        "unmuting cannot bypass context verification",
      );
      f.pc.channel.emit({
        type,
        session: {
          ...providerConfiguration,
          tools: [...providerConfiguration.tools].reverse(),
        },
      });
      assert.equal(f.track.enabled, true);
      assert.equal(f.render().state, "active");
      assert.deepEqual(
        f.pc.channel.sent.map((value) => JSON.parse(value)),
        [{ type: "response.create" }],
      );
      f.pc.channel.emit({ type, session: providerConfiguration });
      assert.equal(
        f.pc.channel.sent.length,
        1,
        "duplicate confirmation cannot greet twice",
      );
      await f.render().end(false);
    } finally {
      f.dispose();
    }
  }
});

test("repeated call presses use one microphone request and early hangup cancels a later grant", async () => {
  const f = fixture();
  try {
    const mic = deferred<MediaStream>();
    f.microphone(() => mic.promise);
    const voice = f.render(),
      first = voice.start("outgoing");
    await voice.start("outgoing");
    await tick();
    assert.equal(f.micRequests, 1);
    await voice.end();
    mic.resolve(f.stream);
    await first;
    await tick();
    assert.equal(f.track.stopped, true);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/realtime").length,
      0,
    );
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      0,
    );
    assert.equal(f.resumed, 1);
    assert.equal(f.render().ending, false);
  } finally {
    f.dispose();
  }
});
test("double hangup shares one request; reset suppresses the pending text resume", async () => {
  const f = fixture();
  try {
    await f.render().start("outgoing");
    const request = deferred<unknown>();
    f.api["/api/call/end"] = () => request.promise;
    const voice = f.render(),
      first = voice.end(),
      second = voice.end(false);
    assert.equal(first, second);
    assert.equal(f.render().ending, true);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      1,
    );
    request.resolve({ session: { revision: 2 } });
    await first;
    assert.equal(f.resumed, 0);
    assert.equal(f.render().ending, false);
  } finally {
    f.dispose();
  }
});
test("cancelling during offer generation never creates a provider call", async () => {
  const f = fixture();
  try {
    const offer = deferred<{ sdp: string }>();
    f.offer(() => offer.promise);
    const voice = f.render(),
      start = voice.start("outgoing");
    await tick();
    await voice.end();
    offer.resolve({ sdp: "late-offer" });
    await start;
    assert.equal(
      f.requests.filter((r) => r.path === "/api/realtime").length,
      0,
    );
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      0,
    );
  } finally {
    f.dispose();
  }
});
test("late SDP after cancellation is hung up by its ID without restoring old session", async () => {
  const f = fixture();
  try {
    const response = deferred<unknown>();
    f.api["/api/realtime"] = () => response.promise;
    const voice = f.render(),
      start = voice.start("outgoing");
    await tick();
    await voice.end();
    const before = f.sessions.length;
    response.resolve({
      callId: "old-call",
      sdp: "late-answer",
      renewAfterSeconds: 660,
      session: { revision: 99 },
    });
    await start;
    assert.equal(f.sessions.length, before);
    assert.equal(f.pc.remote, undefined);
    assert.deepEqual(f.requests.at(-1)?.body, { callId: "old-call" });
  } finally {
    f.dispose();
  }
});
test("permission denial recovers in text without an SDP request", async () => {
  const f = fixture();
  try {
    f.microphone(() =>
      Promise.reject(new DOMException("denied", "NotAllowedError")),
    );
    await f.render().start("incoming");
    assert.match(f.errors[0], /Microphone access is off/);
    assert.equal(f.resumed, 1);
    assert.equal(f.requests[0]?.path, "/api/events");
    assert.equal(f.render().state, "idle");
  } finally {
    f.dispose();
  }
});
test("data channel loss ends the call, cleans microphone, and stale audio cannot alter captions", async () => {
  const f = fixture();
  try {
    await f.render().start("outgoing");
    f.pc.channel.open();
    assert.equal(f.render().state, "active");
    const stale = f.pc.channel.onmessage!;
    f.pc.channel.close();
    await tick();
    assert.equal(f.track.stopped, true);
    assert.equal(f.render().state, "idle");
    stale({
      data: JSON.stringify({
        type: "response.output_audio_transcript.delta",
        delta: "stale",
      }),
    });
    assert.equal(f.render().caption, "");
    assert.equal(f.resumed, 1);
  } finally {
    f.dispose();
  }
});
test("barge-in ignores late words from interrupted or previous responses", async () => {
  const f = fixture();
  try {
    await f.render().start("outgoing");
    const c = f.pc.channel;
    c.emit({ type: "response.created", response: { id: "one" } });
    c.emit({
      type: "response.output_audio_transcript.delta",
      response_id: "one",
      delta: "old",
    });
    c.emit({ type: "input_audio_buffer.speech_started" });
    c.emit({
      type: "response.output_audio_transcript.delta",
      response_id: "one",
      delta: " unwanted",
    });
    assert.equal(f.render().caption, "Listening…");
    c.emit({ type: "response.created", response: { id: "two" } });
    c.emit({
      type: "response.output_audio_transcript.delta",
      response_id: "two",
      delta: "new",
    });
    c.emit({ type: "output_audio_buffer.stopped", response_id: "one" });
    assert.equal(f.render().caption, "new");
    await f.render().end(false);
  } finally {
    f.dispose();
  }
});

test("reconnection grace is cancelled on recovery and a sustained disconnect ends once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  try {
    await f.render().start("outgoing");
    f.pc.connectionState = "disconnected";
    f.pc.onconnectionstatechange?.();
    t.mock.timers.tick(4000);
    f.pc.connectionState = "connected";
    f.pc.onconnectionstatechange?.();
    t.mock.timers.tick(5000);
    await tick();
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      0,
    );
    f.pc.connectionState = "disconnected";
    f.pc.onconnectionstatechange?.();
    t.mock.timers.tick(8000);
    await tick();
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      1,
    );
    assert.equal(f.resumed, 1);
    assert.equal(f.track.stopped, true);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("mute selected while permission is pending applies to the eventual audio track", async () => {
  const f = fixture();
  try {
    const mic = deferred<MediaStream>();
    f.microphone(() => mic.promise);
    const voice = f.render(),
      start = voice.start("outgoing");
    voice.toggleMute();
    mic.resolve(f.stream);
    await start;
    assert.equal(f.track.enabled, false);
    assert.equal(f.render().muted, true);
    await voice.end(false);
    assert.equal(f.render().muted, false);
  } finally {
    f.dispose();
  }
});

test("autoplay denial makes the next sound-button press a playback retry", async () => {
  const f = fixture();
  try {
    await f.render().start("outgoing");
    f.blockPlayback(true);
    f.pc.ontrack?.({ streams: [f.stream] });
    await tick();
    assert.equal(f.render().quiet, true);
    assert.match(f.errors[0], /sound button/);
    f.blockPlayback(false);
    f.render().toggleQuiet();
    await tick();
    assert.equal(f.playbackAttempts, 2);
    assert.equal(f.render().quiet, false);
    await f.render().end(false);
  } finally {
    f.dispose();
  }
});

test("delayed failed-call cleanup cannot clear a newer call after reset", async () => {
  const f = fixture();
  try {
    const cleanup = deferred<unknown>();
    let endingRequests = 0;
    f.api["/api/call/end"] = () =>
      ++endingRequests === 1
        ? cleanup.promise
        : Promise.resolve({ session: { revision: 2 } });
    f.remoteDescription(() => Promise.reject(new Error("old SDP failed")));
    const voice = f.render(),
      oldAttempt = voice.start("outgoing");
    await tick();
    assert.equal(endingRequests, 1);
    await voice.end(false);
    f.remoteDescription(() => Promise.resolve());
    await f.render().start("outgoing");
    const newConnection = f.pc;
    const sessionsBeforeCleanup = f.sessions.length;
    cleanup.resolve({ session: { revision: 999 } });
    await oldAttempt;
    assert.equal(newConnection.connectionState, "new");
    assert.equal(f.render().state, "connecting");
    assert.equal(f.sessions.length, sessionsBeforeCleanup);
    assert.equal(f.errors.length, 0);
    assert.equal(f.requests.filter((r) => r.path === "/api/events").length, 0);
    assert.equal(f.resumed, 0);
    await f.render().end(false);
  } finally {
    f.dispose();
  }
});

test("reset during unavailable-event recovery rejects the late session and resume callback", async () => {
  const f = fixture();
  try {
    const unavailable = deferred<unknown>();
    f.api["/api/events"] = () => unavailable.promise;
    f.microphone(() =>
      Promise.reject(new DOMException("denied", "NotAllowedError")),
    );
    const voice = f.render(),
      failed = voice.start("incoming");
    await tick();
    assert.equal(f.render().ending, true);
    await voice.end(false);
    f.microphone(() => Promise.resolve(f.stream));
    await f.render().start("outgoing");
    const sessionsBefore = f.sessions.length;
    unavailable.resolve({ session: { revision: 999 } });
    await failed;
    assert.equal(f.sessions.length, sessionsBefore);
    assert.equal(f.resumed, 0);
    assert.equal(f.render().state, "connecting");
    assert.equal(f.render().ending, false);
    await f.render().end(false);
  } finally {
    f.dispose();
  }
});

test("manual hangup silences immediately but keeps WebRTC until server acknowledgment", async () => {
  const f = fixture();
  try {
    await f.render().start("outgoing");
    f.pc.channel.open();
    const request = deferred<unknown>();
    f.api["/api/call/end"] = () => request.promise;
    const end = f.render().end();
    assert.equal(f.track.stopped, true);
    assert.notEqual(f.pc.connectionState, "closed");
    assert.equal(f.render().ending, true);
    const duplicate = f.render().end(false);
    assert.equal(duplicate, end);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      1,
    );
    request.resolve({ session: { revision: 2 } });
    await end;
    assert.equal(f.pc.connectionState, "closed");
    assert.equal(f.render().ending, false);
    assert.equal(f.resumed, 0);
  } finally {
    f.dispose();
  }
});

test("failed manual-hangup request still closes local WebRTC and resumes once", async () => {
  const f = fixture();
  try {
    await f.render().start("outgoing");
    const request = deferred<unknown>();
    f.api["/api/call/end"] = () => request.promise;
    const end = f.render().end();
    assert.equal(f.track.stopped, true);
    assert.notEqual(f.pc.connectionState, "closed");
    request.reject(new Error("network gone"));
    await end;
    assert.equal(f.pc.connectionState, "closed");
    assert.equal(f.resumed, 1);
    assert.equal(f.errors.length, 1);
  } finally {
    f.dispose();
  }
});

test("a stalled browser handshake times out, releases resources, and ignores its late result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  try {
    const offer = deferred<{ sdp: string }>();
    f.offer(() => offer.promise);
    const starting = f.render().start("outgoing");
    await tick();
    t.mock.timers.tick(25000);
    await tick();
    assert.equal(f.render().state, "idle");
    assert.equal(f.track.stopped, true);
    assert.equal(f.pc.connectionState, "closed");
    assert.match(f.errors[0], /didn’t connect/);
    assert.equal(f.resumed, 1);
    offer.resolve({ sdp: "late" });
    await starting;
    assert.equal(
      f.requests.filter((r) => r.path === "/api/realtime").length,
      0,
    );
    t.mock.timers.tick(200000);
    await tick();
    assert.equal(f.resumed, 1);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("an open call continues beyond two minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  try {
    await f.render().start("outgoing");
    f.pc.channel.open();
    t.mock.timers.tick(180000);
    await tick();
    assert.equal(f.render().state, "active");
    assert.equal(f.track.stopped, false);
    assert.equal(f.resumed, 0);
    assert.equal(f.errors.length, 0);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      0,
    );
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("malformed voice events are ignored and long captions remain bounded", async () => {
  const f = fixture();
  try {
    await f.render().start("outgoing");
    f.pc.channel.emit(null);
    f.pc.channel.emit("oops");
    f.pc.channel.emit({ type: "response.created", response: { id: "long" } });
    for (let i = 0; i < 20; i++)
      f.pc.channel.emit({
        type: "response.output_audio_transcript.delta",
        response_id: "long",
        delta: "x".repeat(1000),
      });
    assert.equal(f.render().caption.length, 5000);
    await f.render().end(false);
  } finally {
    f.dispose();
  }
});

test("renewal keeps the same microphone, sound settings, elapsed clock and active UI without greeting twice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture();
  try {
    await f.render().start("outgoing");
    const original = f.pc;
    original.channel.open();
    f.render().toggleMute();
    f.render().toggleQuiet();
    t.mock.timers.tick(660000);
    await tick();
    assert.equal(f.render().state, "active");
    assert.equal(f.render().renewing, true);
    assert.equal(f.render().ownsCall("call-one"), false);
    assert.equal(f.render().caption, "Reconnecting…");
    assert.equal(f.micRequests, 1);
    assert.equal(f.track.stopped, false);
    assert.equal(f.track.enabled, false);
    assert.equal(f.render().muted, true);
    assert.equal(f.audios[1].muted, true);
    assert.equal(f.peers[1].tracks[0], f.peers[0].tracks[0]);
    assert.equal(original.connectionState, "closed");
    assert.deepEqual(
      f.requests.find((r) => r.path === "/api/realtime/renew")?.body,
      { callId: "call-one", sdp: "offer" },
    );
    f.pc.channel.open();
    assert.equal(f.render().renewing, false);
    assert.equal(f.render().ownsCall("call-one"), false);
    assert.equal(f.render().ownsCall("call-2"), true);
    assert.equal(f.pc.channel.sent.length, 0);
    assert.equal(original.channel.sent.length, 1);
    t.mock.timers.tick(2000);
    assert.equal(f.render().seconds, 662);
    assert.equal(f.resumed, 0);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      0,
    );
    assert.equal(f.errors.length, 0);
    // A later hosting handoff renews the replacement, not the original call.
    t.mock.timers.tick(658000);
    await tick();
    assert.equal(f.peers.length, 3);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/realtime/renew")[1].body.callId,
      "call-2",
    );
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("renewal waits for a speech pause and forces handoff after the bounded grace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture();
  try {
    await f.render().start("outgoing");
    f.pc.channel.open();
    f.pc.channel.emit({ type: "input_audio_buffer.speech_started" });
    t.mock.timers.tick(660000);
    await tick();
    assert.equal(f.peers.length, 1);
    f.pc.channel.emit({ type: "input_audio_buffer.speech_stopped" });
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(f.peers.length, 2);
    f.pc.channel.open();
    f.pc.channel.emit({ type: "output_audio_buffer.started" });
    t.mock.timers.tick(660000);
    await tick();
    assert.equal(f.peers.length, 2);
    t.mock.timers.tick(40000);
    await tick();
    assert.equal(f.peers.length, 3);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("hangup during renewal stops immediately and terminates a late successor without restoring old state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  try {
    const response = deferred<unknown>();
    f.api["/api/realtime/renew"] = () => response.promise;
    await f.render().start("outgoing");
    const old = f.pc;
    old.channel.open();
    const staleMessage = old.channel.onmessage!;
    const staleClose = old.channel.onclose!;
    t.mock.timers.tick(660000);
    await tick();
    const replacement = f.pc;
    staleClose();
    staleMessage({
      data: JSON.stringify({
        type: "response.output_audio_transcript.delta",
        delta: "stale",
      }),
    });
    assert.equal(f.resumed, 0);
    assert.equal(f.render().caption, "Reconnecting…");
    await f.render().end(false);
    assert.equal(f.track.stopped, true);
    assert.equal(replacement.connectionState, "closed");
    const sessionCount = f.sessions.length;
    response.resolve({
      callId: "late-renewal",
      sdp: "late",
      renewAfterSeconds: 660,
      session: { revision: 999 },
    });
    await tick();
    assert.deepEqual(f.requests.at(-1)?.body, { callId: "late-renewal" });
    assert.equal(replacement.remote, undefined);
    assert.equal(f.sessions.length, sessionCount);
    assert.equal(f.render().state, "idle");
    assert.equal(f.render().renewing, false);
    assert.equal(f.resumed, 0);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("a failed old renewal cannot end a new call started after reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  try {
    const response = deferred<unknown>();
    f.api["/api/realtime/renew"] = () => response.promise;
    await f.render().start("outgoing");
    f.pc.channel.open();
    t.mock.timers.tick(660000);
    await tick();
    await f.render().end(false);
    await f.render().start("outgoing");
    f.pc.channel.open();
    const newPeer = f.pc,
      sessionCount = f.sessions.length,
      endCount = f.requests.filter((r) => r.path === "/api/call/end").length;
    response.reject(new Error("old renewal failed"));
    await tick();
    assert.equal(f.render().state, "active");
    assert.notEqual(newPeer.connectionState, "closed");
    assert.equal(f.sessions.length, sessionCount);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      endCount,
    );
    assert.equal(f.errors.length, 0);
    assert.equal(f.resumed, 0);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("startup budget exhaustion preserves the exact error without requesting paid text recovery", async () => {
  const f = fixture();
  try {
    f.statuses["/api/realtime"] = 429;
    f.api["/api/realtime"] = async () => ({
      code: "budget_exhausted",
      error:
        "This demo has reached its spending budget. Your conversation is saved.",
    });
    await f.render().start("outgoing");
    assert.equal(
      f.errors.at(-1),
      "This demo has reached its spending budget. Your conversation is saved.",
    );
    assert.equal(f.render().state, "idle");
    assert.equal(f.track.stopped, true);
    assert.equal(f.resumed, 0);
    assert.equal(f.peers[0].connectionState, "closed");
  } finally {
    f.dispose();
  }
});

test("renewal budget and transport failures have distinct honest errors and no paid text recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const budget of [false, true]) {
    const f = fixture();
    try {
      f.api["/api/realtime/renew"] = budget
        ? async () => ({
            code: "budget_exhausted",
            error: "The shared demo spending budget is exhausted.",
          })
        : async () => {
            throw new Error("network failed");
          };
      if (budget) f.statuses["/api/realtime/renew"] = 429;
      await f.render().start("outgoing");
      f.pc.channel.open();
      t.mock.timers.tick(660000);
      await tick();
      assert.equal(f.render().state, "idle");
      assert.equal(f.track.stopped, true);
      assert.equal(f.render().renewing, false);
      assert.equal(f.resumed, 0);
      assert.equal(
        f.requests.filter((r) => r.path === "/api/call/end").length,
        1,
      );
      if (budget)
        assert.equal(
          f.errors.at(-1),
          "The shared demo spending budget is exhausted.",
        );
      else {
        assert.match(f.errors.at(-1) || "", /couldn’t reconnect/);
        assert.doesNotMatch(f.errors.at(-1) || "", /budget|allowance/);
      }
    } finally {
      f.dispose();
    }
  }
  t.mock.timers.reset();
});

test("unmount during renewal beacons the owned call and closes a late replacement by its ID", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  try {
    const response = deferred<unknown>();
    f.api["/api/realtime/renew"] = () => response.promise;
    await f.render().start("outgoing");
    f.pc.channel.open();
    t.mock.timers.tick(660000);
    await tick();
    const before = f.sessions.length;
    f.unmount();
    assert.equal(f.beacons.length, 1);
    assert.equal(f.track.stopped, true);
    assert.equal(
      f.peers.every((p) => p.connectionState === "closed"),
      true,
    );
    response.resolve({
      callId: "after-unmount",
      sdp: "answer",
      session: { revision: 999 },
    });
    await tick();
    assert.deepEqual(f.requests.at(-1)?.body, { callId: "after-unmount" });
    assert.equal(f.sessions.length, before);
    assert.equal(f.resumed, 0);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("a slow healthy renewal survives the initial-call timeout and an abandoned handoff is eventually closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  try {
    const response = deferred<unknown>();
    f.api["/api/realtime/renew"] = () => response.promise;
    await f.render().start("outgoing");
    f.pc.channel.open();
    t.mock.timers.tick(660000);
    await tick();
    t.mock.timers.tick(35000);
    await tick();
    assert.equal(f.render().state, "active");
    assert.equal(f.render().renewing, true);
    assert.equal(f.track.stopped, false);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      0,
    );
    t.mock.timers.tick(45000);
    await tick();
    assert.equal(f.render().state, "idle");
    assert.equal(f.track.stopped, true);
    assert.equal(f.resumed, 0);
    assert.match(f.errors.at(-1) || "", /couldn’t reconnect/);
    response.resolve({
      callId: "after-watchdog",
      sdp: "late",
      session: { revision: 999 },
    });
    await tick();
    assert.deepEqual(f.requests.at(-1)?.body, { callId: "after-watchdog" });
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("Live startup verifies resolved history and session identity before one instruction greeting", async () => {
  const f = fixture(liveConfiguration);
  const openingInstruction =
    'Speak immediately: "Hey, it’s Appy. What’s your name?" Then listen.';
  try {
    f.api["/api/realtime"] = async () => ({
      callId: "call-one",
      sdp: "answer",
      contextContract: voiceContextContract(liveConfiguration),
      openingInstruction,
    });
    await f.render().start("incoming");
    const channel = f.pc.channel;
    channel.open(false);
    assert.equal(f.track.enabled, false);
    for (const event of [
      {
        type: "session.updated",
        session: { ...liveConfiguration, id: "call-one" },
      },
      {
        type: "session.started",
        session: { ...liveConfiguration, id: "other-call" },
      },
      {
        type: "session.started",
        session: {
          ...liveConfiguration,
          id: "call-one",
          instructions: "Generic assistant",
        },
      },
      {
        type: "session.started",
        session: { ...liveConfiguration, id: "call-one", input: [] },
      },
      {
        type: "session.started",
        session: { ...liveConfiguration, id: "call-one", input: "malformed" },
      },
      {
        type: "session.started",
        session: {
          ...liveConfiguration,
          id: "call-one",
          delegation: { type: "responses" },
        },
      },
    ]) {
      channel.emit(event);
      assert.equal(f.track.enabled, false);
      assert.equal(channel.sent.length, 0);
    }
    // Server-resolved optional history metadata does not change its content.
    channel.emit({
      type: "session.started",
      session: {
        ...liveConfiguration,
        id: "call-one",
        status: "active",
        input: liveConfiguration.input.map((item, index) => ({
          ...item,
          id: `message-${index}`,
          status: "completed",
          type: "message",
          content: item.content.map((part) => ({
            ...part,
            type: item.role === "assistant" ? "text" : "input_text",
          })),
        })),
      },
    });
    assert.equal(f.track.enabled, true);
    assert.equal(f.render().state, "active");
    const greeting = channel.sent.map((data) => JSON.parse(data));
    assert.equal(greeting.length, 1);
    assert.equal(greeting[0].type, "session.instructions.append");
    assert.equal(greeting[0].delegation_id, null);
    assert.equal(
      greeting[0].content,
      openingInstruction,
      "use the exact server-derived opening cue",
    );
    channel.open();
    channel.emit({
      type: "session.instructions.appended",
      client_event_id: greeting[0].event_id,
    });
    assert.equal(
      channel.sent.length,
      1,
      "no duplicate opening or response.create",
    );
  } finally {
    f.dispose();
  }
});

test("Live compaction warning leaves an active call usable while real errors remain visible", async () => {
  const f = fixture(liveConfiguration);
  try {
    await f.render().start("incoming");
    f.pc.channel.open();
    f.pc.channel.emit({
      type: "error",
      error: {
        code: "missing_scope",
        message:
          "History compaction is disabled for this session because the API key is missing api.responses.write. The session will continue using recent conversation history within its context limit.",
      },
    });
    assert.equal(f.errors.length, 0);
    assert.equal(f.render().state, "active");
    assert.equal(f.track.enabled, true);
    f.pc.channel.emit({
      type: "error",
      error: { code: "missing_scope", message: "Audio permission missing" },
    });
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /problem with the call/);
  } finally {
    f.dispose();
  }
});

test("Live hangup keeps silent media until both session.closed and server persistence finish", async () => {
  const f = fixture(liveConfiguration);
  const response = deferred<unknown>();
  try {
    await f.render().start("outgoing");
    f.pc.channel.open();
    f.api["/api/call/end"] = () => response.promise;
    const ending = f.render().end();
    assert.equal(f.track.enabled, false);
    assert.equal(f.track.stopped, false);
    assert.notEqual(f.pc.connectionState, "closed");
    const duplicate = f.render().end(false);
    assert.equal(ending, duplicate);
    f.pc.channel.emit({
      type: "session.closed",
      session: { id: "wrong-call" },
      usage: { seconds: 10 },
    });
    response.resolve({ session: { revision: 7 } });
    await tick();
    assert.equal(
      f.track.stopped,
      false,
      "an unrelated final event cannot release media",
    );
    f.pc.channel.emit({
      type: "session.closed",
      session: { id: "call-one" },
      reason: "close_requested",
      usage: { seconds: 10 },
    });
    await ending;
    assert.equal(f.track.stopped, true);
    assert.equal(f.pc.connectionState, "closed");
    assert.equal(f.resumed, 0, "reset suppresses optional text continuation");
    assert.equal(f.errors.length, 0);
    assert.equal(
      f.requests.filter((request) => request.path === "/api/call/end").length,
      1,
    );
  } finally {
    f.dispose();
  }
});

test("Live finalization timeout releases resources with an honest connection error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture(liveConfiguration);
  try {
    await f.render().start("outgoing");
    f.pc.channel.open();
    const ending = f.render().end(false);
    await tick();
    t.mock.timers.tick(24999);
    assert.equal(f.track.stopped, false);
    t.mock.timers.tick(1);
    await ending;
    assert.equal(f.track.stopped, true);
    assert.equal(f.render().ending, false);
    assert.match(f.errors.at(-1) || "", /connection dropped/);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("Live continuous captions overlap safely and renewal never sends a second greeting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture(liveConfiguration);
  try {
    await f.render().start("outgoing");
    const original = f.pc;
    original.channel.open();
    original.channel.emit({
      type: "session.output_transcript.delta",
      delta: "We can",
      start_ms: 0,
      end_ms: 100,
    });
    original.channel.emit({
      type: "session.input_transcript.delta",
      delta: "Actually",
      start_ms: 50,
      end_ms: 120,
    });
    original.channel.emit({
      type: "session.output_transcript.delta",
      delta: " start there.",
      start_ms: 100,
      end_ms: 200,
    });
    assert.equal(f.render().caption, "We can start there.");
    assert.equal(f.render().speaking, true);
    t.mock.timers.tick(1500);
    assert.equal(f.render().speaking, false);
    f.render().toggleMute();
    f.render().toggleQuiet();
    t.mock.timers.tick(658500);
    await tick();
    assert.equal(f.render().renewing, true);
    assert.equal(f.track.stopped, false);
    assert.equal(f.track.enabled, false);
    f.pc.channel.open();
    assert.equal(f.render().state, "active");
    assert.equal(f.render().renewing, false);
    assert.equal(f.render().muted, true);
    assert.equal(f.render().quiet, true);
    assert.equal(f.render().seconds, 660);
    assert.equal(f.pc.channel.sent.length, 0);
    assert.equal(original.channel.sent.length, 1);
    assert.equal(f.micRequests, 1);
    assert.equal(f.resumed, 0);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("provider Live finalization ends once and still waits for the persisted server session", async () => {
  const f = fixture(liveConfiguration);
  const response = deferred<unknown>();
  try {
    await f.render().start("incoming");
    f.pc.channel.open();
    f.api["/api/call/end"] = () => response.promise;
    const event = {
      type: "session.closed",
      session: { id: "call-one" },
      reason: "close_requested",
      usage: { seconds: 15 },
    };
    f.pc.channel.emit(event);
    f.pc.channel.emit(event);
    assert.equal(f.track.stopped, false);
    response.resolve({ session: { revision: 5 } });
    await tick();
    assert.equal(f.track.stopped, true);
    assert.equal(f.resumed, 1);
    assert.equal(
      f.requests.filter((request) => request.path === "/api/call/end").length,
      1,
    );
  } finally {
    f.dispose();
  }
});

test("a silent Live opening gets one concrete retry then ends without paid text recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const f = fixture(liveConfiguration);
  try {
    f.api["/api/realtime"] = async () => ({
      callId: "call-one",
      sdp: "answer",
      contextContract: voiceContextContract(liveConfiguration),
      openingInstruction:
        'Speak immediately. Say this opening now: "Hey, you’re back. Ready to keep going?". Then pause and listen.',
    });
    await f.render().start("outgoing");
    f.pc.channel.open();
    t.mock.timers.tick(5999);
    assert.equal(f.pc.channel.sent.length, 1);
    f.pc.channel.emit({ type: "session.instructions.appended" });
    t.mock.timers.tick(1);
    const retry = JSON.parse(f.pc.channel.sent[1]);
    assert.equal(retry.type, "session.instructions.append");
    assert.equal(retry.delegation_id, null);
    assert.equal(
      retry.content,
      'Speak now in English. Say exactly "Hey, you’re back. Ready to keep going?", then stop speaking and listen.',
    );
    assert.equal(f.track.enabled, true);
    t.mock.timers.tick(7999);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      0,
    );
    t.mock.timers.tick(1);
    assert.equal(
      f.requests.filter((r) => r.path === "/api/call/end").length,
      1,
    );
    assert.equal(f.track.enabled, false);
    f.pc.channel.emit({ type: "session.closed", session: { id: "call-one" } });
    await tick();
    assert.equal(f.pc.channel.sent.length, 2, "no repeated recues");
    assert.equal(f.track.stopped, true);
    assert.equal(f.resumed, 0);
    assert.match(f.errors.at(-1) || "", /didn’t start speaking/);
    assert.doesNotMatch(f.errors.at(-1) || "", /budget|spend/);
  } finally {
    f.dispose();
    t.mock.timers.reset();
  }
});

test("caller or assistant speech cancels both the Live retry and final silence watchdog", async (t) => {
  for (const type of [
    "session.input_transcript.delta",
    "session.output_transcript.delta",
  ]) {
    for (const afterRetry of [false, true]) {
      t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
      const f = fixture(liveConfiguration);
      try {
        await f.render().start("outgoing");
        f.pc.channel.open();
        if (afterRetry) t.mock.timers.tick(6000);
        f.pc.channel.emit({ type, delta: "Hello" });
        t.mock.timers.tick(20000);
        assert.equal(f.pc.channel.sent.length, afterRetry ? 2 : 1);
        assert.equal(
          f.requests.filter((r) => r.path === "/api/call/end").length,
          0,
        );
        assert.equal(f.render().state, "active");
        assert.equal(f.errors.length, 0);
      } finally {
        f.dispose();
        t.mock.timers.reset();
      }
    }
  }
});

test("hangup and transport renewal cancel Live opening watchdogs", async (t) => {
  for (const renewal of [false, true]) {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const f = fixture(liveConfiguration);
    try {
      f.api["/api/realtime"] = async () => ({
        callId: "call-one",
        sdp: "answer",
        contextContract: voiceContextContract(liveConfiguration),
        renewAfterSeconds: renewal ? 1 : 660,
      });
      await f.render().start("outgoing");
      const old = f.pc;
      old.channel.open();
      if (renewal) {
        t.mock.timers.tick(1000);
        await tick();
        f.pc.channel.open();
      } else {
        const ending = f.render().end(false);
        old.channel.emit({
          type: "session.closed",
          session: { id: "call-one" },
        });
        await ending;
      }
      t.mock.timers.tick(20000);
      assert.equal(old.channel.sent.length, 1);
      if (renewal) {
        assert.equal(f.pc.channel.sent.length, 0);
        assert.equal(f.render().state, "active");
      }
      assert.equal(f.errors.length, 0);
    } finally {
      f.dispose();
      t.mock.timers.reset();
    }
  }
});
