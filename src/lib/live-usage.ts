// Standard gpt-live-1 pricing verified 2026-09-28:
// https://developers.openai.com/api/docs/models/gpt-live-1
// https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live
// https://developers.openai.com/api/docs/guides/live-conversations
export const LIVE_PRICING_VERSION = "2026-09-28";
export const LIVE_USD_PER_MINUTE = 0.05;
export const LIVE_WEBRTC_INITIALIZATION_SECONDS = 15;
type Transport = "webrtc" | "websocket";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nanos = (dollars: number) => Math.ceil(dollars * 1e9);
const closeReasons = new Set([
  "close_requested",
  "expired",
  "content",
  "remote_hangup",
  "connection_lost",
]);

export function liveVoiceCostUsd(
  model: string,
  seconds: unknown,
  transport: Transport = "webrtc",
) {
  if (model !== "gpt-live-1" || !count(seconds)) return undefined;
  // WebRTC charges 15 seconds on creation, credited against the running
  // duration. Keep that initialization floor, never add it to reported time.
  const duration = Math.max(
    transport === "webrtc" ? LIVE_WEBRTC_INITIALIZATION_SECONDS : 0,
    seconds,
  );
  const cost = duration / (60 / LIVE_USD_PER_MINUTE);
  return Number.isSafeInteger(nanos(cost)) ? cost : undefined;
}

// Feed only events from the authenticated server-side connection for this
// provider session. Browser events and elapsed wall time are not usage proof.
// The runtime must also enforce a duration deadline while usage updates lag.
export function liveUsageLedger(
  model: string,
  options: { sessionId: string; transport: Transport },
) {
  let unknown = model !== "gpt-live-1" || !options.sessionId;
  let seconds: number | null = null;
  let closed = false;
  let started = false;
  let reason: string | null = null;
  let backendNanodollars = 0;
  const pending = new Set<string>();
  const backend = new Map<string, number | undefined>();
  const invalidate = () => {
    unknown = true;
  };
  const voiceDollars = () =>
    liveVoiceCostUsd(model, seconds ?? 0, options.transport);
  const totalNanodollars = () => {
    const voice = voiceDollars();
    if (voice === undefined) return undefined;
    const sum = nanos(voice) + backendNanodollars;
    return Number.isSafeInteger(sum) ? sum : undefined;
  };
  return {
    observe(value: unknown) {
      const event = record(value);
      if (!event || typeof event.type !== "string") return invalidate();
      // This adapter uses our separately metered Together client backend.
      // An unexpected hosted Responses completion has no verified price here;
      // never refund its allowance as though that work were free.
      if (event.type === "response.event") {
        const nested = record(event.event);
        if (nested && ["response.completed", "response.failed", "response.incomplete"].includes(String(nested.type)))
          return invalidate();
      }
      if (
        ![
          "session.started",
          "session.usage.updated",
          "session.closed",
        ].includes(event.type)
      )
        return;
      const session = record(event.session);
      if (
        session &&
        (session.id !== options.sessionId ||
          (session.model !== undefined && session.model !== model))
      )
        return invalidate();
      if (event.type === "session.started") {
        if (!session) return invalidate();
        started = true;
        return;
      }
      const reported = record(event.usage)?.seconds;
      if (
        !count(reported) ||
        liveVoiceCostUsd(model, reported, options.transport) === undefined
      )
        return invalidate();
      if (event.type === "session.closed") {
        if (
          !session ||
          typeof event.reason !== "string" ||
          !closeReasons.has(event.reason)
        )
          return invalidate();
        // A final receipt below an already observed cumulative total cannot
        // establish complete billing; neither can conflicting final receipts.
        if (
          (seconds !== null && reported < seconds) ||
          (closed && (reported !== seconds || event.reason !== reason))
        )
          return invalidate();
        seconds = reported;
        reason = event.reason;
        closed = true;
      } else if (closed) {
        if (seconds !== null && reported > seconds) invalidate();
      } else {
        // Updates are cumulative snapshots, not costs to add. Delayed/replayed
        // older updates must not decrease the current guarded amount.
        seconds = Math.max(seconds ?? 0, reported);
      }
    },
    markBackendPending(id: string) {
      if (!id) return invalidate();
      if (backend.has(id) || pending.has(id)) return;
      if (closed) invalidate();
      pending.add(id);
    },
    addBackendDollars(cost: number | undefined, id: string) {
      if (!id) return invalidate();
      const priced =
        count(cost) && Number.isSafeInteger(nanos(cost))
          ? nanos(cost)
          : undefined;
      if (backend.has(id)) {
        if (backend.get(id) !== priced) invalidate();
        return;
      }
      pending.delete(id);
      backend.set(id, priced);
      if (
        priced === undefined ||
        !Number.isSafeInteger(backendNanodollars + priced)
      )
        return invalidate();
      backendNanodollars += priced;
    },
    get dollars() {
      const total = totalNanodollars();
      return unknown || total === undefined ? Infinity : total / 1e9;
    },
    snapshot() {
      const total = totalNanodollars();
      return {
        pricingVersion: LIVE_PRICING_VERSION,
        model,
        transport: options.transport,
        reportedSeconds: seconds,
        billableSeconds: Math.max(
          options.transport === "webrtc"
            ? LIVE_WEBRTC_INITIALIZATION_SECONDS
            : 0,
          seconds ?? 0,
        ),
        voiceDollars: voiceDollars() ?? null,
        backendDollars: backendNanodollars / 1e9,
        reportedDollars: total === undefined ? null : total / 1e9,
        unknown,
        sessionStarted: started,
        finalConfirmed: closed,
        closeReason: reason,
        backendCalls: backend.size,
        pendingBackendCalls: pending.size,
      };
    },
    settlementCents() {
      const total = totalNanodollars();
      if (unknown || !closed || pending.size || total === undefined)
        return undefined;
      return Math.ceil(total / 1e7);
    },
  };
}
