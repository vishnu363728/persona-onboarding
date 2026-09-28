import WebSocket from "ws";
import { addMessage, applyMemory, endCall, type Session } from "./domain";
import { gmailReady } from "./agent";
import {
  liveConfiguration,
  liveOpeningInstruction,
  liveState,
  LIVE_MODEL,
  type LiveConfiguration,
} from "./live-config";
import { voiceContextContract } from "./voice-contract";
import { generateLiveTurn } from "./live-backend";
import { liveUsageLedger, LIVE_USD_PER_MINUTE } from "./live-usage";
import {
  getSession,
  mutateSession,
  reserveAvailableBudget,
  settleBudget,
  rawStore,
} from "./store";
import { pollVoiceStop } from "./voice-stop";
import {
  VOICE_SHUTDOWN_HEADROOM_CENTS,
  VOICE_SUPERVISION_TIMEOUT_SECONDS,
  VOICE_BUDGET_EVENT,
  VOICE_ACCOUNTING_ERROR_EVENT,
  VOICE_RENEWAL_ERROR_EVENT,
} from "./voice-limits";

export async function hangupLive(callId: string) {
  const r = await fetch(
    `https://api.openai.com/v1/live/sessions/${encodeURIComponent(callId)}/hangup`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  return r.ok || r.status === 404;
}

export async function createLive(s: Session, sdp: string, continuing = false) {
  if (!process.env.OPENAI_API_KEY)
    throw new Error(
      "Voice isn’t connected yet. We can keep going in messages.",
    );
  const { reservation, reservedCents } = await reserveAvailableBudget(
    VOICE_SHUTDOWN_HEADROOM_CENTS + 1,
  );
  const configuration = liveConfiguration(s, gmailReady(), continuing);
  const response = await fetch("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": s.id,
    },
    body: JSON.stringify({
      session: configuration,
      transport: { type: "webrtc", sdp },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    if ([400, 401, 403, 404, 422, 429].includes(response.status))
      await settleBudget(reservation, 0);
    console.error(
      "Live session creation",
      response.status,
      (await response.text()).slice(0, 700),
    );
    throw new Error(
      "The call couldn’t connect. You can try again or keep chatting.",
    );
  }
  const result = await response.json();
  if (
    typeof result.session?.id !== "string" ||
    typeof result.transport?.sdp !== "string"
  )
    throw new Error("The voice service returned an incomplete connection.");
  return {
    sdp: result.transport.sdp as string,
    callId: result.session.id as string,
    reservation,
    reservedCents,
    model: LIVE_MODEL,
    configuration,
    contextContract: voiceContextContract(configuration),
    openingInstruction: liveOpeningInstruction(s, continuing),
  };
}

type Event = {
  type: string;
  event_id?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  delegation?: { id?: string; target?: string };
  [key: string]: unknown;
};

export function superviseLiveCall(
  sessionId: string,
  callId: string,
  billing: {
    reservation: string;
    reservedCents?: number;
    model: string;
    configuration: LiveConfiguration;
    supervisionDeadline?: number;
  },
  socket = new WebSocket(
    `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(callId)}/attach`,
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    },
  ),
  generateTurn = generateLiveTurn,
) {
  const startedAt = Date.now();
  const usage = liveUsageLedger(billing.model, {
    sessionId: callId,
    transport: "webrtc",
  });
  const allowance =
    ((billing.reservedCents ?? 51) - VOICE_SHUTDOWN_HEADROOM_CENTS) / 100;
  let ending = false,
    finalized = false,
    socketClosed = false,
    settling = false,
    failed = false;
  let reason: string | undefined;
  let queue = Promise.resolve();
  let backendQueue = Promise.resolve();
  let spokenEndTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let resolveFinal!: () => void;
  const finalEvent = new Promise<void>((r) => {
    resolveFinal = r;
  });
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Voice memory connection timed out.")),
      8000,
    );
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Voice memory connection failed."));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Voice memory connection failed."));
    });
  });
  const send = (event: unknown) => {
    if (!socketClosed && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(event));
  };
  const append = (
    type: string,
    content: string,
    delegationId: string | null = null,
  ) =>
    send({
      type,
      event_id: crypto.randomUUID(),
      delegation_id: delegationId,
      content,
    });
  const transcriptEvents = new Set<string>();
  const delegates = new Set<string>();
  type Fragment = {
    id: string;
    role: "user" | "assistant";
    delta: string;
    start: number;
    end: number;
  };
  let fragments: Fragment[] = [];
  const groups: Partial<
    Record<
      "user" | "assistant",
      { id: string; end: number; textLength: number }
    >
  > = {};
  let lastUserAt = 0,
    lastOutputAt = 0,
    userRevision = 0;
  let latestUserTranscriptEnd = -1;
  let latestAssistantTranscriptStart = -1;
  let lastGroupedRole: "user" | "assistant" | undefined;
  let transcriptWorkTimer: ReturnType<typeof setTimeout> | undefined;
  let coveredRevision = 0;
  let cachedState: ReturnType<typeof liveState> | undefined;
  const save = async (fn: (s: Session) => void) =>
    mutateSession(sessionId, (s) => {
      if (!s.retiredAt && s.call.id === callId) fn(s);
    });
  const flush = () => {
    const batch = fragments;
    fragments = [];
    if (!batch.length) return queue;
    queue = queue
      .then(async () => {
        await save((s) => {
          for (const f of batch.sort(
            (a, b) => a.start - b.start || a.end - b.end,
          )) {
            let group = groups[f.role];
            if (
              !group ||
              lastGroupedRole !== f.role ||
              !s.messages.some((m) => m.id === group!.id) ||
              f.start - group.end > 1800 ||
              group.textLength + f.delta.length > 10000
            ) {
              group = {
                id: `${callId}:${f.role}:${f.id}`,
                end: f.end,
                textLength: 0,
              };
              groups[f.role] = group;
              addMessage(s, {
                id: group.id,
                role: f.role,
                text: "",
                channel: "voice",
                at: startedAt + f.start,
              });
            }
            const message = s.messages.find((m) => m.id === group!.id);
            if (message) {
              (message.voiceFragments ??= []).push({
                startMs: f.start,
                endMs: f.end,
                delta: f.delta,
              });
              message.voiceFragments.sort(
                (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
              );
              message.text = message.voiceFragments
                .map((fragment) => fragment.delta)
                .join("");
              message.at = startedAt + message.voiceFragments[0].startMs;
            }
            lastGroupedRole = f.role;
            group.end = Math.max(group.end, f.end);
            group.textLength += f.delta.length;
          }
          s.messages.sort((a, b) => a.at - b.at);
        });
      })
      .catch(() => {
        failed = true;
        console.error("Live transcript persistence failed");
      });
    return queue;
  };
  const closeSocket = () => {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
      const timer = setTimeout(() => socket.terminate(), 1500);
      timer.unref?.();
      socket.once("close", () => clearTimeout(timer));
    }
  };
  const stop = async (stopReason?: string) => {
    reason ||= stopReason;
    if (!ending) {
      ending = true;
      send({ type: "session.close", event_id: crypto.randomUUID() });
    }
    if (socketClosed) return finalized;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      finalEvent,
      new Promise<void>((r) => {
        timer = setTimeout(r, 9000);
      }),
    ]);
    clearTimeout(timer);
    if (!finalized) {
      await hangupLive(callId).catch(() => false);
      closeSocket();
    }
    return finalized;
  };
  const settle = async () => {
    if (settling) return;
    settling = true;
    clearInterval(poll);
    clearInterval(flushing);
    clearTimeout(watchdog);
    clearTimeout(spokenEndTimer);
    clearTimeout(transcriptWorkTimer);
    await flush();
    await backendQueue.catch(() => {});
    await flush();
    await save((s) => {
      if (["active", "connecting"].includes(s.call.status) || reason)
        endCall(
          s,
          reason === VOICE_RENEWAL_ERROR_EVENT ? "failed" : "ended",
          reason,
        );
    });
    const cents = failed ? undefined : usage.settlementCents();
    const receipt = {
      sessionId,
      callId,
      reservation: billing.reservation,
      reservedCents: billing.reservedCents,
      ...usage.snapshot(),
      at: Date.now(),
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
  };
  const delegate = (id: string, application = false) => {
    if (delegates.has(id) || (ending && !application)) return;
    delegates.add(id);
    usage.markBackendPending(id);
    const providerDelegationId = application ? null : id;
    backendQueue = backendQueue
      .then(async () => {
        // Delegation can precede the trailing transcript. Give the fragments a
        // brief chance to arrive, then use the same persisted conversation.
        if (!application) await new Promise((r) => setTimeout(r, 650));
        if (userRevision > 0 && coveredRevision === userRevision) {
          usage.addBackendDollars(0, id);
          if (!application && !ending && cachedState) {
            append(
              "session.thinking.append",
              JSON.stringify({ saved: true, ...cachedState }).slice(0, 1800),
              id,
            );
          }
          return;
        }
        // A correction may not trigger another provider delegation. Refresh once
        // from the actual newest transcript instead of silently dropping facts.
        // Each paid attempt has a separate receipt ID; the provider-facing
        // delegation ID remains the original one.
        for (let attempt = 0; attempt < 2; attempt++) {
          const billingId = attempt ? `${id}:latest` : id;
          if (attempt) usage.markBackendPending(billingId);
          const revision = userRevision;
          await flush();
          const current = await getSession(sessionId);
          if (!current || current.retiredAt || current.call.id !== callId) {
            usage.addBackendDollars(0, billingId);
            return;
          }
          let billed = false;
          try {
            const result = await generateTurn(current, (dollars) => {
              billed = true;
              usage.addBackendDollars(dollars, billingId);
            });
            if (userRevision !== revision) {
              if (ending) return;
              if (
                attempt === 0 &&
                Number.isFinite(usage.dollars) &&
                usage.dollars < allowance
              )
                continue;
              append(
                "session.thinking.append",
                "The user added a newer detail while this request ran. Use their latest correction; the earlier result was not applied. Delegate again if it still requires saving or an action.",
                providerDelegationId,
              );
              return;
            }
            let state: ReturnType<typeof liveState> | undefined;
            let newGmailCard = false;
            await save((s) => {
              const previousGmail = s.gmail.status;
              applyMemory(s, result.turn.memory);
              if (
                result.turn.action === "offer_gmail" &&
                !["connected", "declined", "deferred"].includes(s.gmail.status)
              )
                s.gmail.status = "offered";
              newGmailCard =
                previousGmail !== "offered" && s.gmail.status === "offered";
              state = liveState(s, gmailReady());
            });
            if (state) {
              coveredRevision = revision;
              cachedState = state;
            }
            if (!state || ending) return;
            const alreadyAnswered =
              userRevision > 0 &&
              latestAssistantTranscriptStart >= latestUserTranscriptEnd;
            append(
              "session.thinking.append",
              JSON.stringify({ saved: true, ...state }).slice(0, 1800),
              providerDelegationId,
            );
            if (!application && alreadyAnswered && !newGmailCard && !result.endCall)
              append(
                "session.thinking.append",
                `You already spoke after this user turn. Do not repeat an acknowledgment, question, or answer. This backend result is quiet context; use only genuinely new useful facts if still needed: ${result.turn.reply.slice(0, 1600)}`,
                providerDelegationId,
              );
            // Live usually already answered a name/correction naturally. App
            // memory and already-answered provider work must not echo it.
            if ((!application && !alreadyAnswered) || newGmailCard || result.endCall) {
              append(
                "session.commentary.append",
                newGmailCard
                  ? gmailReady()
                    ? "I've put a Gmail connection card in our messages. Tap View Gmail connection, then Connect Gmail; we can keep talking. It's optional and only verifies your account here."
                    : "Gmail connection is not configured right now; we can keep talking."
                  : result.turn.reply.slice(0, 1600),
                providerDelegationId,
              );
            }
            if (result.endCall) {
              // Allow the brief requested acknowledgment to play, then finish with
              // final transcripts and duration still observed on the sideband.
              spokenEndTimer = setTimeout(
                () => void stop("Call ended · continuing in messages"),
                1400,
              );
            }
            return;
          } catch {
            if (!billed) usage.addBackendDollars(undefined, billingId);
            if (!ending)
              append(
                "session.thinking.append",
                "The backend could not finish this request. Do not claim the action succeeded. Continue from the conversation and briefly offer to try again.",
                providerDelegationId,
              );
            return;
          }
        }
      })
      .catch(() => {
        failed = true;
      });
  };
  const queueTranscriptWork = () => {
    clearTimeout(transcriptWorkTimer);
    if (userRevision > coveredRevision)
      delegate(`transcript:${callId}:${userRevision}`, true);
  };
  const flushing = setInterval(() => {
    void flush();
  }, 500);
  let polling = false;
  let gmailSnapshot = "";
  const spokenGmailEvents = new Set<string>();
  const poll = setInterval(() => {
    if (socketClosed || polling) return;
    polling = true;
    void (async () => {
      const elapsedCost =
        ((Date.now() - startedAt) / 60000) * LIVE_USD_PER_MINUTE;
      if (
        !ending &&
        (!Number.isFinite(usage.dollars) ||
          Math.max(
            elapsedCost + usage.snapshot().backendDollars,
            usage.dollars,
          ) >= allowance)
      ) {
        await stop(
          Number.isFinite(usage.dollars)
            ? VOICE_BUDGET_EVENT
            : VOICE_ACCOUNTING_ERROR_EVENT,
        );
        return;
      }
      if (!ending)
        await pollVoiceStop(
          rawStore,
          sessionId,
          callId,
          (request) =>
            request.kind !== "renewal" ||
            Date.now() - Math.max(lastUserAt, lastOutputAt) > 1600,
          () => stop(),
        );
      if (!ending) {
        const s = await getSession(sessionId);
        if (s?.call.id === callId && !s.retiredAt) {
          const gmail = JSON.stringify({
            status: s.gmail.status,
            email: s.gmail.email,
          });
          if (gmailSnapshot && gmail !== gmailSnapshot)
            append(
              "session.thinking.append",
              `Verified Gmail state: ${gmail}. Do not interrupt or repeat an offer; use this state if relevant.`,
            );
          gmailSnapshot = gmail;
          // Only server-created OAuth events merit unsolicited spoken feedback.
          // A preference saved from speech already had its conversational reply.
          const oauthEvents = s.messages.filter(
            (m) =>
              m.role === "event" &&
              m.channel === "system" &&
              (m.id.startsWith("gmail:") ||
                m.id.startsWith("gmail-disconnected:")),
          );
          const freshEvents = oauthEvents.filter(
            (m) => m.at > startedAt && !spokenGmailEvents.has(m.id),
          );
          for (const event of oauthEvents) spokenGmailEvents.add(event.id);
          // Multiple UI actions can complete between polls. Speak only the latest
          // result that is still true, never a stale connection followed by a skip.
          const latest = freshEvents.at(-1);
          const feedback =
            latest?.text.startsWith("Gmail connected · ") &&
            s.gmail.status === "connected"
              ? "Your Gmail account is connected. We can keep going with what you wanted help with."
              : latest?.text ===
                    "Gmail connection cancelled · continuing the conversation"
                ? "No problem, you cancelled that connection. We can keep going here."
                : latest?.text === "Gmail disconnected" &&
                    s.gmail.status !== "connected"
                  ? "Gmail is disconnected. We can keep going here."
                  : undefined;
          if (feedback && !ending && !socketClosed)
            append("session.commentary.append", feedback);
        }
      }
    })()
      .catch(() => console.error("Live coordination failed"))
      .finally(() => {
        polling = false;
      });
  }, 500);
  const watchdog = setTimeout(
    () => {
      void stop(VOICE_RENEWAL_ERROR_EVENT);
    },
    Math.max(
      0,
      (billing.supervisionDeadline ??
        startedAt + VOICE_SUPERVISION_TIMEOUT_SECONDS * 1000) - Date.now(),
    ),
  );
  socket.on("message", (raw) => {
    if (socketClosed || finalized) return;
    let e: Event;
    try {
      e = JSON.parse(raw.toString());
    } catch {
      failed = true;
      void stop(VOICE_ACCOUNTING_ERROR_EVENT);
      return;
    }
    if (!e || typeof e !== "object" || typeof e.type !== "string") {
      failed = true;
      void stop(VOICE_ACCOUNTING_ERROR_EVENT);
      return;
    }
    // Register the final pending memory task before the usage ledger becomes
    // final. It remains part of this call's reservation through settlement.
    if (e.type === "session.closed") queueTranscriptWork();
    usage.observe(e);
    if (
      [
        "session.input_transcript.delta",
        "session.output_transcript.delta",
      ].includes(e.type) &&
      typeof e.delta === "string" &&
      typeof e.start_ms === "number" &&
      Number.isFinite(e.start_ms) &&
      e.start_ms >= 0 &&
      typeof e.end_ms === "number" &&
      Number.isFinite(e.end_ms) &&
      e.end_ms >= e.start_ms
    ) {
      const id = e.event_id || `${e.type}:${e.start_ms}:${e.end_ms}:${e.delta}`;
      if (!transcriptEvents.has(id)) {
        transcriptEvents.add(id);
        const role =
          e.type === "session.input_transcript.delta" ? "user" : "assistant";
        if (role === "user") {
          lastUserAt = Date.now();
          userRevision++;
          latestUserTranscriptEnd = Math.max(latestUserTranscriptEnd, e.end_ms);
          clearTimeout(transcriptWorkTimer);
          transcriptWorkTimer = setTimeout(queueTranscriptWork, 900);
        } else {
          lastOutputAt = Date.now();
          latestAssistantTranscriptStart = Math.max(latestAssistantTranscriptStart, e.start_ms);
        }
        fragments.push({
          id,
          role,
          delta: e.delta,
          start: e.start_ms,
          end: e.end_ms,
        });
      }
    }
    if (
      e.type === "session.delegation.created" &&
      e.delegation?.target === "client" &&
      e.delegation.id
    )
      delegate(e.delegation.id);
    if (e.type === "session.closed") {
      ending = true;
      finalized = usage.snapshot().finalConfirmed;
      resolveFinal();
      if (!finalized) {
        failed = true;
        void hangupLive(callId).catch(() => false);
      }
      void settle()
        .catch(() => {
          failed = true;
          console.error("Live settlement failed");
        })
        .finally(() => {
          closeSocket();
          resolveDone();
        });
    }
  });
  socket.on("close", () => {
    if (!finalized) queueTranscriptWork();
    socketClosed = true;
    clearTimeout(spokenEndTimer);
    if (!finalized) {
      ending = true;
      void hangupLive(callId).catch(() => false);
      void settle()
        .catch(() => console.error("Live incomplete finalization"))
        .finally(resolveDone);
    }
  });
  socket.on("error", () => {
    failed = true;
  });
  return {
    ready: connected,
    connected,
    done,
    close: () => {
      void stop();
    },
    abort: () => stop(),
  };
}
