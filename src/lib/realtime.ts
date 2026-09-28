import WebSocket from "ws";
import { endCall, type Session } from "./domain";
import { voiceEventHandler, type VoiceEvent } from "./voice-events";
import {
  realtimeConfiguration,
  type RealtimeConfiguration,
} from "./voice-config";
import { voiceContextContract } from "./voice-contract";
import { createLive, superviseLiveCall, hangupLive } from "./live";
import { LIVE_MODEL, type LiveConfiguration } from "./live-config";
import { gmailReady } from "./agent";
import { pollVoiceStop } from "./voice-stop";
import { voiceGmailSync } from "./voice-gmail";
import {
  VOICE_RESERVATION_CENTS,
  VOICE_SHUTDOWN_HEADROOM_CENTS,
  VOICE_SUPERVISION_TIMEOUT_SECONDS,
  VOICE_BUDGET_EVENT,
  VOICE_ACCOUNTING_ERROR_EVENT,
  VOICE_RENEWAL_ERROR_EVENT,
} from "./voice-limits";
import {
  mutateSession,
  reserveAvailableBudget,
  settleBudget,
  rawStore,
} from "./store";
import { voiceUsageLedger, verifiedVoiceClose } from "./voice-usage";
export async function hangup(callId: string, acknowledged?: () => void) {
  if (!callId.startsWith("rtc_")) {
    const ended = await hangupLive(callId);
    if (ended) acknowledged?.();
    return ended;
  }
  const r = await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!r.ok && r.status !== 404) console.error("Hangup status", r.status);
  if (r.ok) acknowledged?.();
  return r.ok || r.status === 404;
}
export async function createRealtime(
  s: Session,
  sdp: string,
  continuing = false,
) {
  if ((process.env.REALTIME_MODEL || LIVE_MODEL) === LIVE_MODEL)
    return createLive(s, sdp, continuing);
  if (!process.env.OPENAI_API_KEY)
    throw new Error(
      "Voice isn’t connected yet. We can keep going in messages.",
    );
  const { reservation, reservedCents } = await reserveAvailableBudget(
    VOICE_SHUTDOWN_HEADROOM_CENTS + 1,
  );
  const model = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
  const configuration = realtimeConfiguration(
    s,
    model,
    gmailReady(),
    continuing,
  );
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(configuration));
  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Safety-Identifier": s.id,
    },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    if ([400, 401, 403, 404, 422, 429].includes(response.status))
      await settleBudget(reservation, 0);
    console.error(
      "Realtime API status",
      response.status,
      (await response.text()).slice(0, 500),
    );
    throw new Error(
      "The call couldn’t connect. You can try again or keep chatting.",
    );
  }
  const callId = response.headers.get("location")?.split("/").pop();
  if (!callId) throw new Error("The voice service did not return a call ID.");
  return {
    sdp: await response.text(),
    callId,
    reservation,
    reservedCents,
    model,
    configuration,
    contextContract: voiceContextContract(configuration),
  };
}
function superviseRealtimeCall(
  sessionId: string,
  callId: string,
  billing: {
    reservation: string;
    model: string;
    configuration: RealtimeConfiguration;
    reservedCents?: number;
    supervisionDeadline?: number;
  },
  socket = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
  ),
) {
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let errored = false;
  let termination: Promise<boolean> | undefined;
  let completedEndCallHangup = false;
  let manualStopHangup = false;
  let controlledLimitHangup = false;
  let providerAcknowledgedHangup = false;
  let stopReason: string | undefined;
  const playing = new Set<string>();
  const usageLimit =
    ((billing.reservedCents ?? VOICE_RESERVATION_CENTS) -
      VOICE_SHUTDOWN_HEADROOM_CENTS) /
    100;
  const terminateProvider = () =>
    (termination ??= (async () => {
      // Hangup is idempotent. Retry one transient failure within the shutdown
      // budget instead of caching a failed attempt for the life of the call.
      for (let attempt = 0; attempt < 2; attempt++) {
        const ended = await hangup(callId, () => {
          providerAcknowledgedHangup = true;
        }).catch(() => false);
        if (ended) return true;
      }
      return false;
    })());
  const usage = voiceUsageLedger(billing.model);
  let processingCost = 0;
  let draining = false;
  // Speech can still be in the provider's input buffer when the browser stops
  // its mic. It is not represented by pendingTranscripts until committed.
  let uncommittedSpeech = false;
  const connected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Voice memory connection timed out.")),
      8000,
    );
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Voice memory connection failed."));
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      reject(new Error("Voice memory connection failed."));
    });
  });
  const send = (event: unknown) => {
    if (draining && (event as { type?: string })?.type === "response.create")
      return;
    if (socket.readyState === WebSocket.OPEN && !termination)
      socket.send(JSON.stringify(event));
  };
  const drainBeforeHangup = async () => {
    draining = true;
    const snapshot = usage.snapshot();
    // A hard hangup can close the observer before the cancelled response's
    // final usage arrives. Cancel first and collect its completion receipt.
    if (snapshot.pendingResponses && socket.readyState === WebSocket.OPEN)
      send({ type: "response.cancel" });
    if (playing.size && socket.readyState === WebSocket.OPEN)
      send({ type: "output_audio_buffer.clear" });
    const deadline = Date.now() + 3000;
    let commitRequested = false;
    while (!closed && Date.now() < deadline) {
      // Only flush speech actually observed on the authenticated sideband;
      // blindly committing an empty buffer produces a provider error. Wait
      // for its real committed event before considering that speech drained.
      if (
        uncommittedSpeech &&
        !commitRequested &&
        socket.readyState === WebSocket.OPEN
      ) {
        commitRequested = true;
        send({ type: "input_audio_buffer.commit" });
      }
      const current = usage.snapshot();
      if (
        !uncommittedSpeech &&
        !current.pendingResponses &&
        !current.pendingTranscripts
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // A missing commit acknowledgment is missing accounting evidence, not
    // proof that no audio work occurred. Preserve the original reservation.
    if (uncommittedSpeech) errored = true;
  };
  // Session lifecycle events arrive on the browser's WebRTC connection, not
  // this sideband. Reapply settings here; the browser independently checks its
  // actual session against contextContract before enabling its mic/greeting.
  socket.once("open", () => {
    const { model: _model, ...session } = billing.configuration;
    send({ type: "session.update", session });
  });
  const memorySnapshot = (s: Session) =>
    JSON.stringify({
      profile: s.profile,
      gmail: s.gmail,
      preference: s.call.preference,
      helping: s.helping,
    });
  const save = async (fn: (s: Session) => void | Promise<void>) => {
    const saved = await mutateSession(sessionId, async (s) => {
      if (s.call.id !== callId || s.retiredAt) return false;
      const before = memorySnapshot(s);
      await fn(s);
      return before !== memorySnapshot(s);
    });
    if (saved.result && !closed && !termination) {
      // Keep durable facts in the session instructions, not only in audio or
      // tool history that the provider can eventually truncate. Update only
      // when saved facts change; the long shared instruction prefix is stable.
      const configuration = realtimeConfiguration(
        saved.session,
        billing.model,
        gmailReady(),
        "memory",
      );
      send({
        type: "session.update",
        session: { type: "realtime", instructions: configuration.instructions },
      });
    }
    return saved;
  };
  const close = () => {
    if (
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING
    )
      return;
    socket.close(1000);
    // ws normally waits up to 30s for a close handshake. Bound shutdown so
    // persistence/settlement finish inside this route's serverless lifetime.
    const force = setTimeout(() => socket.terminate(), 1500);
    force.unref?.();
    socket.once("close", () => clearTimeout(force));
  };
  const syncGmail = voiceGmailSync(
    sessionId,
    callId,
    () => rawStore.read<Session>("session:" + sessionId),
    () => !closed && !termination && socket.readyState === WebSocket.OPEN,
    send,
  );
  let pollingStop = false;
  const stopPoll = setInterval(() => {
    if (closed || termination || pollingStop) return;
    pollingStop = true;
    const checking = pollVoiceStop(
      rawStore,
      sessionId,
      callId,
      (request) => {
        const snapshot = usage.snapshot();
        return (
          !closed &&
          !termination &&
          socket.readyState === WebSocket.OPEN &&
          (request.kind !== "renewal" ||
            (!snapshot.pendingResponses &&
              !snapshot.pendingTranscripts &&
              !playing.size))
        );
      },
      async () => {
        manualStopHangup = true;
        await drainBeforeHangup();
        return terminateProvider().then(() => providerAcknowledgedHangup);
      },
    )
      .then(async (handled) => {
        if (handled) close();
        else await syncGmail();
      })
      .catch(() => {
        // The endpoint has its own direct-hangup fallback. A storage read failure
        // alone does not corrupt authenticated model usage or prove a shutdown.
        console.error("Voice stop coordination failed");
      })
      .finally(() => {
        pollingStop = false;
      });
    // Keep acknowledgment writes alive through close and serverless completion.
    queue = queue.catch(() => {}).then(() => checking);
  }, 1000);
  const timer = setTimeout(
    () => {
      // A healthy client renews the transport first. If renewal never arrives,
      // stop before the hosting process can disappear with billable audio alive.
      if (!closed && !termination) controlledLimitHangup = true;
      stopReason = VOICE_RENEWAL_ERROR_EVENT;
      void terminateProvider().finally(close);
      queue = queue
        .catch(() => {})
        .then(async () => {
          await save((s) => {
            if (["active", "connecting", "renewing"].includes(s.call.status))
              endCall(s, "failed", VOICE_RENEWAL_ERROR_EVENT);
          });
        })
        .catch((e) => {
          console.error(
            "Voice timeout persistence",
            e instanceof Error ? e.message : "failed",
          );
        });
    },
    Math.max(
      0,
      (billing.supervisionDeadline ??
        Date.now() + VOICE_SUPERVISION_TIMEOUT_SECONDS * 1000) - Date.now(),
    ),
  );
  const handle = voiceEventHandler({
    save,
    send,
    gmailAvailable: gmailReady(),
    cost: () => processingCost,
    limitUsd: usageLimit,
    schedule: (work, delayMs) => {
      const pending = setTimeout(() => {
        if (closed) return;
        // Begin the fallback on time even if storage is slow, then join its
        // promise into the queue so final shutdown still waits for persistence.
        const finishing = work().catch((e) => {
          errored = true;
          console.error(
            "Voice ending",
            e instanceof Error ? e.message : "failed",
          );
        });
        queue = queue.catch(() => {}).then(() => finishing);
      }, delayMs);
      return () => clearTimeout(pending);
    },
    stop: async (reason) => {
      try {
        // This reason is emitted only after a completed, validated end_call.
        // Do not attribute an existing timeout/network shutdown to the tool.
        if (
          !closed &&
          !termination &&
          reason === "Call ended · continuing in messages"
        )
          completedEndCallHangup = true;
        await terminateProvider();
        await save((s) => endCall(s, "ended", reason));
      } finally {
        close();
      }
    },
  });
  socket.on("message", (data) => {
    if (closed) return;
    let event: VoiceEvent;
    try {
      event = JSON.parse(data.toString());
      if (!event || typeof event !== "object" || typeof event.type !== "string")
        throw new Error("Invalid voice event");
    } catch {
      errored = true;
      stopReason = VOICE_ACCOUNTING_ERROR_EVENT;
      void terminateProvider().finally(close);
      return;
    }
    // Billing must not wait behind session/blob locks. Keep each event's cost
    // for ordered tool processing, but enforce the aggregate guard immediately.
    usage.observe(event);
    if (event.type === "input_audio_buffer.speech_started")
      uncommittedSpeech = true;
    if (
      ["input_audio_buffer.committed", "input_audio_buffer.cleared"].includes(
        event.type,
      )
    )
      uncommittedSpeech = false;
    // Automatic VAD can race the user's hangup after we flush their final
    // utterance. Preserve its receipt, but do not generate another answer.
    if (draining && event.type === "response.created")
      send({ type: "response.cancel" });
    if (event.type === "output_audio_buffer.started")
      playing.add(event.response_id || "");
    if (
      ["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(
        event.type,
      )
    )
      playing.clear();
    const snapshot = usage.snapshot();
    const eventCost = snapshot.unknown ? Infinity : usage.dollars;
    if (
      !termination &&
      (!Number.isFinite(eventCost) || eventCost >= usageLimit)
    ) {
      controlledLimitHangup = !snapshot.unknown;
      stopReason = snapshot.unknown
        ? VOICE_ACCOUNTING_ERROR_EVENT
        : VOICE_BUDGET_EVENT;
      void terminateProvider().finally(close);
    }
    queue = queue
      .then(() => {
        processingCost = eventCost;
        return handle(event);
      })
      .catch((e) => {
        errored = true;
        console.error(
          "Voice event persistence",
          e instanceof Error ? e.message : "failed",
        );
      });
  });
  socket.on("close", (code) => {
    if (closed) return;
    // Capture now, not after the queue drains: later cleanup hangup cannot
    // prove there was no billable work after sideband visibility was lost.
    const terminationStartedBeforeClose = termination !== undefined;
    closed = true;
    clearTimeout(timer);
    clearInterval(stopPoll);
    // Never leave provider audio running while a prior persistence task waits
    // for its lock. This post-close cleanup does not qualify for a refund.
    const providerTermination = terminateProvider();
    queue = queue
      .catch(() => {})
      .then(async () => {
        handle.dispose();
        const providerEnded = await providerTermination;
        await save((s) => {
          if (stopReason || ["active", "connecting"].includes(s.call.status))
            endCall(
              s,
              stopReason === VOICE_RENEWAL_ERROR_EVENT ? "failed" : "ended",
              stopReason,
            );
        });
        const cents = usage.settlementCents(
          verifiedVoiceClose(
            code,
            providerEnded && providerAcknowledgedHangup,
            errored,
            completedEndCallHangup || manualStopHangup || controlledLimitHangup,
            terminationStartedBeforeClose,
          ),
        );
        const receipt = {
          callId,
          sessionId,
          reservation: billing.reservation,
          reservedCents: billing.reservedCents ?? VOICE_RESERVATION_CENTS,
          model: billing.model,
          contextVerification:
            "WebRTC peer checks exact application contract before enabling audio",
          at: Date.now(),
          closeCode: code,
          providerEnded,
          completedEndCallHangup,
          manualStopHangup,
          controlledLimitHangup,
          providerAcknowledgedHangup,
          terminationStartedBeforeClose,
          errored,
          ...usage.snapshot(),
          proposedSettlementCents: cents ?? null,
          settledCents: null as number | null,
          finalized: false,
        };
        await rawStore.write("voice-usage:" + callId, receipt);
        if (cents !== undefined) {
          await settleBudget(billing.reservation, cents);
          receipt.settledCents = cents;
        }
        receipt.finalized = true;
        await rawStore.write("voice-usage:" + callId, receipt);
        console.info("Voice usage receipt", JSON.stringify(receipt));
      })
      .catch((e) => {
        console.error(
          "Voice shutdown persistence",
          e instanceof Error ? e.message : "failed",
        );
      })
      .finally(() => {
        resolveDone();
      });
  });
  socket.on("error", () => {
    errored = true;
    console.error("Voice sideband disconnected");
  });
  return {
    ready: connected,
    connected,
    done,
    close,
    abort: async () => {
      // A failed startup has not returned SDP to the client. Confirm provider
      // shutdown through this observer so zero usage can settle accurately.
      manualStopHangup = true;
      await terminateProvider();
      close();
    },
  };
}

export function superviseCall(
  sessionId: string,
  callId: string,
  billing: { reservation: string; model: string; configuration: RealtimeConfiguration | LiveConfiguration;
    reservedCents?: number; supervisionDeadline?: number },
  socket?: WebSocket,
) {
  if (billing.model === LIVE_MODEL)
    return superviseLiveCall(sessionId, callId, { ...billing, configuration: billing.configuration as LiveConfiguration }, socket);
  return superviseRealtimeCall(sessionId, callId, { ...billing, configuration: billing.configuration as RealtimeConfiguration }, socket);
}
