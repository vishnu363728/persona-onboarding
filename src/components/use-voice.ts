"use client";
import {
  isLiveContract,
  LIVE_OPENING_INSTRUCTION,
  LIVE_OPENING_RETRY_DELAY_MS,
  LIVE_OPENING_RETRY_TIMEOUT_MS,
  liveOpeningRetryInstruction,
  voiceContextContract,
} from "@/lib/voice-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicSession } from "@/lib/domain";
import { acquireMicrophone } from "./voice-microphone";
export type VoiceState = "idle" | "connecting" | "active";
type Events = {
  onSession: (s: PublicSession) => void;
  onEnded: () => void;
  onError: (s: string) => void;
};
type Connection = {
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  channel?: RTCDataChannel;
  id?: string;
  renewal?: ReturnType<typeof setTimeout>;
  connecting?: ReturnType<typeof setTimeout>;
  reconnect?: ReturnType<typeof setTimeout>;
  contextReady?: boolean;
  contextContract?: string;
  openingInstruction?: string;
  finalized?: boolean;
  finalEvent: Promise<void>;
  resolveFinalEvent: () => void;
  inputActivity?: ReturnType<typeof setTimeout>;
  outputActivity?: ReturnType<typeof setTimeout>;
  openingTimer?: ReturnType<typeof setTimeout>;
  inputSpeaking: boolean;
  outputSpeaking: boolean;
};
class VoiceRequestError extends Error {
  constructor(
    message: string,
    readonly budgetExhausted: boolean,
  ) {
    super(message);
  }
}
// A renewed peer shares the original microphone. Disposing a peer must not
// stop that stream; only ending the logical call releases microphone tracks.
function disposePeer(c: Connection | null) {
  if (!c) return;
  clearTimeout(c.renewal);
  clearTimeout(c.connecting);
  clearTimeout(c.reconnect);
  clearTimeout(c.inputActivity);
  clearTimeout(c.outputActivity);
  clearTimeout(c.openingTimer);
  c.pc.onconnectionstatechange = null;
  c.pc.ontrack = null;
  if (c.channel) {
    c.channel.onopen = null;
    c.channel.onmessage = null;
    c.channel.onclose = null;
    c.channel.close();
  }
  c.pc.close();
  c.audio.pause();
  c.audio.srcObject = null;
}
async function terminateLateCall(id: string) {
  await fetch("/api/call/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId: id }),
    signal: AbortSignal.timeout(25000),
  }).catch(() => {});
}
export function useVoice(events: Events) {
  const callbacks = useRef(events);
  callbacks.current = events;
  const [state, setState] = useState<VoiceState>("idle"),
    [ending, setEnding] = useState(false),
    [renewing, setRenewing] = useState(false),
    [muted, setMuted] = useState(false),
    [quiet, setQuiet] = useState(false),
    [caption, setCaption] = useState(""),
    [speaking, setSpeaking] = useState(false),
    [seconds, setSeconds] = useState(0);
  const current = useRef<Connection | null>(null),
    retiring = useRef<Connection | null>(null),
    clock = useRef<{
      started: number;
      timer: ReturnType<typeof setInterval>;
    } | null>(null),
    version = useRef(0),
    busy = useRef(false),
    handshakeRequested = useRef(false),
    renewingRef = useRef(false),
    renewCall = useRef<(connection: Connection) => Promise<void>>(
      async () => {},
    ),
    endTask = useRef<{ promise: Promise<void>; resume: boolean } | null>(null),
    microphoneRequest = useRef<AbortController | null>(null),
    desiredMute = useRef(false),
    desiredQuiet = useRef(false);
  const cleanup = useCallback(() => {
    microphoneRequest.current?.abort();
    microphoneRequest.current = null;
    handshakeRequested.current = false;
    const c = current.current;
    current.current = null;
    c?.stream.getTracks().forEach((t) => t.stop());
    disposePeer(c);
    disposePeer(retiring.current);
    retiring.current = null;
    clearInterval(clock.current?.timer);
    clock.current = null;
    renewingRef.current = false;
    setRenewing(false);
    setState("idle");
    setSpeaking(false);
    setCaption("");
    desiredMute.current = false;
    desiredQuiet.current = false;
    setMuted(false);
    setQuiet(false);
    setSeconds(0);
  }, []);
  const end = useCallback(
    (shouldResume = true) => {
      if (endTask.current) {
        endTask.current.resume &&= shouldResume;
        return endTask.current.promise;
      }
      const generation = ++version.current;
      busy.current = true;
      setEnding(true);
      microphoneRequest.current?.abort();
      microphoneRequest.current = null;
      const c = current.current,
        id = c?.id,
        requested = handshakeRequested.current;
      // Silence immediately, but keep WebRTC alive until the supervised hangup
      // acknowledges. Closing it first creates an unobserved billing interval.
      clearInterval(clock.current?.timer);
      for (const peer of [c, retiring.current]) {
        if (!peer) continue;
        clearTimeout(peer.renewal);
        clearTimeout(peer.connecting);
        clearTimeout(peer.reconnect);
        clearTimeout(peer.inputActivity);
        clearTimeout(peer.outputActivity);
        clearTimeout(peer.openingTimer);
        peer.stream.getTracks().forEach((t) => {
          // Live needs a continuous media timeline while final events drain.
          // Disabling sends silence; stopping is reserved for final cleanup.
          if (isLiveContract(peer.contextContract)) t.enabled = false;
          else t.stop();
        });
        peer.audio.pause();
      }
      setState("idle");
      setSpeaking(false);
      setCaption("");
      const task = { promise: Promise.resolve(), resume: shouldResume };
      endTask.current = task;
      task.promise = (async () => {
        try {
          // Before this tab sends SDP it cannot own a provider call. An
          // unscoped hangup could otherwise end another tab’s conversation.
          if (!id && !requested) {
            await Promise.resolve();
            return;
          }
          const closingStarted = Date.now();
          const r = await fetch("/api/call/end", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callId: id }),
            signal: AbortSignal.timeout(25000),
          });
          const d = await r.json();
          if (!r.ok) throw new Error("Call termination failed");
          if (d.session && generation === version.current)
            callbacks.current.onSession(d.session);
          if (c && isLiveContract(c.contextContract) && !c.finalized) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                c.finalEvent,
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("Live finalization incomplete")),
                    Math.max(0, 25000 - (Date.now() - closingStarted)),
                  );
                }),
              ]);
            } finally {
              clearTimeout(timeout);
            }
          }
        } catch {
          if (generation === version.current)
            callbacks.current.onError(
              "The connection dropped. Your conversation is saved.",
            );
        } finally {
          if (endTask.current === task) endTask.current = null;
          if (generation === version.current) {
            cleanup();
            busy.current = false;
            setEnding(false);
            if (task.resume) callbacks.current.onEnded();
          }
        }
      })();
      return task.promise;
    },
    [cleanup],
  );
  const createPeer = useCallback(
    (stream: MediaStream, attempt: number, handoff: boolean, id?: string) => {
      const pc = new RTCPeerConnection(),
        audio = new Audio();
      audio.autoplay = true;
      audio.muted = desiredQuiet.current;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !desiredMute.current;
      });
      let resolveFinalEvent!: () => void;
      const finalEvent = new Promise<void>((resolve) => {
        resolveFinalEvent = resolve;
      });
      const c: Connection = {
        pc,
        stream,
        audio,
        id,
        inputSpeaking: false,
        outputSpeaking: false,
        finalEvent,
        resolveFinalEvent,
      };
      current.current = c;
      const valid = () => attempt === version.current && current.current === c;
      const failHandoff = (message: string) => {
        callbacks.current.onError(message);
        const endedVersion = version.current + 1;
        void end(false).then(() => {
          if (version.current === endedVersion)
            callbacks.current.onError(message);
        });
      };
      c.connecting = setTimeout(
        () => {
          if (!valid()) return;
          if (handoff)
            failHandoff(
              "The call couldn’t reconnect. Your conversation is saved. You can try calling again.",
            );
          else {
            callbacks.current.onError(
              "The call didn’t connect. You can try again or keep chatting.",
            );
            void end();
          }
        },
        handoff ? 80000 : 25000,
      );
      pc.ontrack = (e) => {
        if (!valid()) return;
        audio.srcObject = e.streams[0];
        audio.muted = desiredQuiet.current;
        audio.play().catch(() => {
          if (!valid()) return;
          desiredQuiet.current = true;
          audio.muted = true;
          setQuiet(true);
          callbacks.current.onError("Tap the sound button to hear the call.");
        });
      };
      for (const track of stream.getTracks()) {
        track.enabled = false;
        pc.addTrack(track, stream);
      }
      const channel = pc.createDataChannel("oai-events");
      c.channel = channel;
      let opened = false,
        activeResponseId: string | undefined,
        acceptingTranscript = true;
      let openingHeard = false;
      const heardSpeech = () => {
        openingHeard = true;
        clearTimeout(c.openingTimer);
      };
      const openingFailed = () => {
        if (!valid() || openingHeard) return;
        const message =
          "The call connected but didn’t start speaking. Please try calling again; your conversation is saved.";
        callbacks.current.onError(message);
        const endedVersion = version.current + 1;
        void end(false).then(() => {
          if (version.current === endedVersion)
            callbacks.current.onError(message);
        });
      };
      const watchOpening = () => {
        c.openingTimer = setTimeout(() => {
          if (!valid() || openingHeard) return;
          try {
            channel.send(
              JSON.stringify({
                type: "session.instructions.append",
                event_id: `persona_greeting_retry_${crypto.randomUUID()}`,
                delegation_id: null,
                content: liveOpeningRetryInstruction(c.openingInstruction),
              }),
            );
          } catch {
            openingFailed();
            return;
          }
          c.openingTimer = setTimeout(
            openingFailed,
            LIVE_OPENING_RETRY_TIMEOUT_MS,
          );
        }, LIVE_OPENING_RETRY_DELAY_MS);
      };
      const activate = () => {
        if (!valid() || opened) return;
        opened = true;
        c.contextReady = true;
        stream.getAudioTracks().forEach((track) => {
          track.enabled = !desiredMute.current;
        });
        clearTimeout(c.connecting);
        // The replacement server already carries the conversation context.
        // Starting a fresh response here would greet the user a second time.
        if (!handoff) {
          channel.send(
            JSON.stringify(
              isLiveContract(c.contextContract)
                ? {
                    type: "session.instructions.append",
                    event_id: `persona_greeting_${crypto.randomUUID()}`,
                    delegation_id: null,
                    content: c.openingInstruction || LIVE_OPENING_INSTRUCTION,
                  }
                : { type: "response.create" },
            ),
          );
          if (isLiveContract(c.contextContract)) watchOpening();
        } else {
          disposePeer(retiring.current);
          retiring.current = null;
          renewingRef.current = false;
          setRenewing(false);
        }
        setState("active");
        setCaption("Listening…");
        if (!clock.current) {
          const started = Date.now();
          clock.current = {
            started,
            timer: setInterval(() => {
              if (attempt === version.current)
                setSeconds(Math.floor((Date.now() - started) / 1000));
            }, 1000),
          };
        }
      };
      channel.onopen = () => {};
      channel.onmessage = (event) => {
        let e;
        try {
          e = JSON.parse(event.data);
          if (!e || typeof e !== "object" || typeof e.type !== "string") return;
        } catch {
          return;
        }
        const live = isLiveContract(c.contextContract);
        // Ending invalidates all other callbacks. Keep only finalization alive
        // for the exact retained peer so shutdown cannot lose its final event.
        if (
          live &&
          e.type === "session.closed" &&
          e.session?.id === c.id &&
          (current.current === c || retiring.current === c)
        ) {
          c.finalized = true;
          c.resolveFinalEvent();
          if (valid()) void end();
          return;
        }
        if (!valid()) return;
        if (
          live
            ? e.type === "session.started" && e.session?.id === c.id
            : ["session.created", "session.updated"].includes(e.type)
        ) {
          try {
            if (
              e.session &&
              c.contextContract &&
              voiceContextContract(e.session) === c.contextContract
            )
              activate();
          } catch {
            // Malformed provider metadata must never unlock the microphone.
          }
          return;
        }
        if (live) {
          if (!opened) return;
          if (
            [
              "session.output_transcript.delta",
              "session.input_transcript.delta",
            ].includes(e.type) &&
            typeof e.delta === "string" &&
            e.delta.trim()
          )
            heardSpeech();
          if (
            e.type === "session.output_transcript.delta" &&
            typeof e.delta === "string"
          ) {
            c.outputSpeaking = true;
            setSpeaking(true);
            setCaption((old) =>
              ["Listening…", "Connecting…", "Reconnecting…"].includes(old)
                ? e.delta.slice(-5000)
                : (old + e.delta).slice(-5000),
            );
            clearTimeout(c.outputActivity);
            // Live has no audio-done/turn boundary. This is caption activity,
            // used only for the UI and preferring a quiet renewal moment.
            c.outputActivity = setTimeout(() => {
              if (!valid()) return;
              c.outputSpeaking = false;
              setSpeaking(false);
            }, 1500);
          }
          if (
            e.type === "session.input_transcript.delta" &&
            typeof e.delta === "string"
          ) {
            c.inputSpeaking = true;
            clearTimeout(c.inputActivity);
            c.inputActivity = setTimeout(() => {
              if (valid()) c.inputSpeaking = false;
            }, 1500);
          }
          // This specific provider warning explicitly leaves audio running.
          // Other missing permissions and genuine call errors remain visible.
          const compactionWarning =
            e.error?.code === "missing_scope" &&
            typeof e.error?.message === "string" &&
            e.error.message.includes("History compaction is disabled") &&
            e.error.message.includes("session will continue");
          if (e.type === "error" && !compactionWarning)
            callbacks.current.onError(
              "There was a problem with the call. You can hang up and continue here.",
            );
          return;
        }
        if (
          e.response_id &&
          activeResponseId &&
          e.response_id !== activeResponseId
        )
          return;
        if (
          e.type === "response.output_audio_transcript.delta" &&
          acceptingTranscript &&
          typeof e.delta === "string"
        ) {
          c.outputSpeaking = true;
          setSpeaking(true);
          setCaption((old) =>
            ["Listening…", "Connecting…", "Reconnecting…"].includes(old)
              ? e.delta.slice(-5000)
              : (old + e.delta).slice(-5000),
          );
        }
        if (e.type === "response.created") {
          activeResponseId = e.response?.id;
          acceptingTranscript = true;
          setCaption("");
          setSpeaking(false);
        }
        if (e.type === "output_audio_buffer.started") c.outputSpeaking = true;
        if (
          [
            "output_audio_buffer.stopped",
            "output_audio_buffer.cleared",
          ].includes(e.type)
        ) {
          c.outputSpeaking = false;
          setSpeaking(false);
          setCaption("Listening…");
        }
        if (e.type === "input_audio_buffer.speech_started") {
          c.inputSpeaking = true;
          c.outputSpeaking = false;
          acceptingTranscript = false;
          setSpeaking(false);
          setCaption("Listening…");
        }
        if (e.type === "input_audio_buffer.speech_stopped")
          c.inputSpeaking = false;
        if (e.type === "error")
          callbacks.current.onError(
            "There was a problem with the call. You can hang up and continue here.",
          );
      };
      channel.onclose = () => {
        if (!valid()) return;
        if (handoff && !opened)
          failHandoff(
            "The call couldn’t reconnect. Your conversation is saved. You can try calling again.",
          );
        else void end();
      };
      pc.onconnectionstatechange = () => {
        if (!valid()) return;
        if (["failed", "closed"].includes(pc.connectionState)) {
          if (handoff && !opened)
            failHandoff(
              "The call couldn’t reconnect. Your conversation is saved. You can try calling again.",
            );
          else void end();
        }
        if (pc.connectionState === "disconnected") {
          setCaption("Reconnecting…");
          clearTimeout(c.reconnect);
          c.reconnect = setTimeout(() => {
            if (!valid() || pc.connectionState !== "disconnected") return;
            if (handoff && !opened)
              failHandoff(
                "The call couldn’t reconnect. Your conversation is saved. You can try calling again.",
              );
            else void end();
          }, 8000);
        }
        if (pc.connectionState === "connected") {
          clearTimeout(c.reconnect);
          if (!renewingRef.current) setCaption("Listening…");
        }
      };
      return c;
    },
    [end],
  );
  const scheduleRenewal = useCallback(
    (c: Connection, secondsUntilRenewal: unknown) => {
      // Bound malformed server data without introducing a duration-based hangup.
      const delay =
        typeof secondsUntilRenewal === "number" &&
        Number.isFinite(secondsUntilRenewal)
          ? Math.max(1, Math.min(660, secondsUntilRenewal))
          : 660;
      const due = Date.now() + delay * 1000;
      const renewAtPause = () => {
        if (current.current !== c || renewingRef.current || !busy.current)
          return;
        // Give a sentence up to forty seconds to finish, while retaining ample
        // room for negotiation before the hosting worker's safety deadline.
        if ((c.inputSpeaking || c.outputSpeaking) && Date.now() < due + 40000) {
          c.renewal = setTimeout(renewAtPause, 1000);
          return;
        }
        void renewCall.current(c);
      };
      clearTimeout(c.renewal);
      c.renewal = setTimeout(renewAtPause, delay * 1000);
    },
    [],
  );
  renewCall.current = async (old) => {
    if (current.current !== old || renewingRef.current || !old.id) return;
    const attempt = version.current;
    renewingRef.current = true;
    setRenewing(true);
    setSpeaking(false);
    setCaption("Reconnecting…");
    clearTimeout(old.renewal);
    clearTimeout(old.connecting);
    clearTimeout(old.reconnect);
    clearTimeout(old.openingTimer);
    retiring.current = old;
    let c: Connection | undefined, serverId: string | undefined;
    try {
      c = createPeer(old.stream, attempt, true, old.id);
      const valid = () => attempt === version.current && current.current === c;
      const offer = await c.pc.createOffer();
      if (!valid()) return;
      await c.pc.setLocalDescription(offer);
      if (!valid()) return;
      const response = await fetch("/api/realtime/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: old.id, sdp: offer.sdp }),
        signal: AbortSignal.timeout(75000),
      });
      const data = await response.json();
      if (!response.ok)
        throw new VoiceRequestError(
          data.error ||
            "The call couldn’t reconnect. Your conversation is saved. You can try calling again.",
          data.code === "budget_exhausted",
        );
      serverId = data.callId;
      if (!valid()) {
        if (serverId) await terminateLateCall(serverId);
        return;
      }
      c.id = serverId;
      c.contextContract = data.contextContract;
      c.openingInstruction = data.openingInstruction;
      if (data.session) callbacks.current.onSession(data.session);
      await c.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      if (!valid()) return;
      disposePeer(old);
      if (retiring.current === old) retiring.current = null;
      scheduleRenewal(c, data.renewAfterSeconds);
    } catch (error) {
      if (attempt !== version.current) return;
      // A handoff failure is not an invitation to spend on a text completion.
      // Preserve the server's specific budget error; transport failures remain
      // connection errors and do not pretend the budget was exhausted.
      const message =
        error instanceof VoiceRequestError
          ? error.message
          : "The call couldn’t reconnect. Your conversation is saved. You can try calling again.";
      const endedVersion = version.current + 1;
      await end(false);
      if (version.current === endedVersion) callbacks.current.onError(message);
    }
  };
  const start = useCallback(
    async (direction: "incoming" | "outgoing") => {
      if (busy.current) return;
      busy.current = true;
      const attempt = ++version.current;
      handshakeRequested.current = false;
      setState("connecting");
      setCaption("Connecting…");
      let stream: MediaStream | undefined, serverId: string | undefined;
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "This browser can’t use the microphone here. Try Chrome or Safari, or keep chatting.",
          );
        const microphone = new AbortController();
        microphoneRequest.current = microphone;
        stream = await acquireMicrophone(
          () =>
            navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            }),
          microphone.signal,
        );
        if (attempt !== version.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const c = createPeer(stream, attempt, false);
        const offer = await c.pc.createOffer();
        if (attempt !== version.current) return;
        await c.pc.setLocalDescription(offer);
        if (attempt !== version.current) return;
        handshakeRequested.current = true;
        const response = await fetch("/api/realtime", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp: offer.sdp, direction }),
          signal: AbortSignal.timeout(35000),
        });
        const data = await response.json();
        if (!response.ok)
          throw new VoiceRequestError(
            data.error || "The call couldn’t connect.",
            data.code === "budget_exhausted",
          );
        serverId = data.callId;
        if (attempt !== version.current) {
          if (serverId) await terminateLateCall(serverId);
          return;
        }
        c.id = serverId;
        c.contextContract = data.contextContract;
        c.openingInstruction = data.openingInstruction;
        if (data.session) callbacks.current.onSession(data.session);
        await c.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        if (attempt !== version.current || current.current !== c) return;
        scheduleRenewal(c, data.renewAfterSeconds);
      } catch (error) {
        // A reset may already have acquired this browser's next microphone.
        // Only the old attempt's own stream can be released here.
        if (attempt !== version.current) return;
        stream?.getTracks().forEach((t) => t.stop());
        if (serverId) await terminateLateCall(serverId);
        if (attempt !== version.current) return;
        const denied =
          error instanceof DOMException &&
          ["NotAllowedError", "PermissionDeniedError"].includes(error.name);
        const exhausted =
          error instanceof VoiceRequestError && error.budgetExhausted;
        cleanup();
        setEnding(true);
        callbacks.current.onError(
          denied
            ? "Microphone access is off. Allow it in your browser to call, or keep chatting here."
            : error instanceof Error
              ? error.message
              : "The call couldn’t connect. We can keep chatting.",
        );
        const r = await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: "call_unavailable" }),
          signal: AbortSignal.timeout(15000),
        }).catch(() => null);
        if (r?.ok && attempt === version.current) {
          const d = await r.json().catch(() => null);
          if (d?.session && attempt === version.current)
            callbacks.current.onSession(d.session);
        }
        if (attempt === version.current) {
          busy.current = false;
          setEnding(false);
          if (!exhausted) callbacks.current.onEnded();
        }
      }
    },
    [cleanup, createPeer, scheduleRenewal],
  );
  const toggleMute = () => {
    const next = !desiredMute.current;
    desiredMute.current = next;
    current.current?.stream.getAudioTracks().forEach((t) => {
      t.enabled = !!current.current?.contextReady && !next;
    });
    setMuted(next);
  };
  const toggleQuiet = () => {
    const next = !desiredQuiet.current;
    desiredQuiet.current = next;
    if (retiring.current) retiring.current.audio.muted = next;
    if (current.current) {
      const audio = current.current.audio;
      audio.muted = next;
      if (!next)
        void audio.play().catch(() => {
          if (current.current?.audio !== audio) return;
          desiredQuiet.current = true;
          audio.muted = true;
          setQuiet(true);
          callbacks.current.onError(
            "Sound is blocked by your browser. Tap the sound button to try again.",
          );
        });
    }
    setQuiet(next);
  };
  const ownsCall = useCallback(
    (id?: string) =>
      Boolean(
        id &&
        !renewingRef.current &&
        current.current?.id === id &&
        !endTask.current,
      ),
    [],
  );
  useEffect(() => {
    const leave = () => {
      const id = current.current?.id;
      if (id)
        navigator.sendBeacon(
          "/api/call/end",
          new Blob([JSON.stringify({ callId: id })], {
            type: "application/json",
          }),
        );
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
      version.current++;
      microphoneRequest.current?.abort();
      const c = current.current;
      current.current = null;
      c?.stream.getTracks().forEach((t) => t.stop());
      disposePeer(c);
      disposePeer(retiring.current);
      retiring.current = null;
      clearInterval(clock.current?.timer);
      clock.current = null;
    };
  }, []);
  return {
    state,
    ending,
    renewing,
    muted,
    quiet,
    caption,
    speaking,
    seconds,
    start,
    end,
    ownsCall,
    toggleMute,
    toggleQuiet,
  };
}
