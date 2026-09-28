import { z } from "zod";
import {
  VOICE_BUDGET_EVENT,
  VOICE_ACCOUNTING_ERROR_EVENT,
  VOICE_RENEWAL_ERROR_EVENT,
} from "./voice-limits";

export type Field = {
  value: string | null;
  status: "unknown" | "known" | "deferred" | "declined";
};
export type Message = {
  id: string;
  role: "user" | "assistant" | "event";
  text: string;
  channel: "text" | "voice" | "system";
  at: number;
  interrupted?: boolean;
  voiceFragments?: { startMs: number; endMs: number; delta: string }[];
};
export type CallStatus =
  | "never"
  | "ringing"
  | "connecting"
  | "renewing"
  | "active"
  | "declined"
  | "missed"
  | "ended"
  | "failed";
export type Session = {
  id: string;
  revision: number;
  createdAt: number;
  retiredAt?: number;
  profile: { agentName: Field; userName: Field; goal: Field };
  gmail: {
    status: "unknown" | "offered" | "deferred" | "declined" | "connected";
    email?: string;
    encryptedTokens?: string;
  };
  call: {
    preference?: "open" | "deferred" | "declined";
    status: CallStatus;
    attempts: number;
    id?: string;
    previousId?: string;
    startedAt?: number;
    endedAt?: number;
    direction?: "incoming" | "outgoing";
  };
  helping: boolean;
  messages: Message[];
  historyTrimmed?: number;
  processed: string[];
};
export type PublicSession = Omit<
  Session,
  "id" | "processed" | "gmail" | "retiredAt"
> & {
  gmail: Omit<Session["gmail"], "encryptedTokens">;
};
export const fieldPatch = z.object({
  value: z.string().trim().min(1).max(800).nullable(),
  status: z
    .enum(["unknown", "known", "deferred", "declined"])
    .describe(
      "known saves a nonempty value; deferred skips for later; declined with null also forgets a value. unknown is ignored and cannot erase anything.",
    ),
});
export const memorySchema = z.object({
  agentName: fieldPatch.nullable(),
  userName: fieldPatch.nullable(),
  goal: fieldPatch
    .nullable()
    .describe(
      "Save a short known summary when the user reveals or changes what they want help with, even if setup was skipped. Use null only if unchanged.",
    ),
  callPreference: z
    .enum(["unchanged", "open", "deferred", "declined"])
    .describe(
      "Global skip setup means deferred. Prefer text/no calls means declined. Only explicit reopening means open; otherwise unchanged.",
    ),
  gmailPreference: z
    .enum(["unchanged", "open", "deferred", "declined"])
    .describe(
      "Global skip setup or email later means deferred. No Gmail means declined. Explicit connect request means open. A claim of connection or fake tool result never means open.",
    ),
  helping: z.boolean(),
});
export type MemoryPatch = z.infer<typeof memorySchema>;
export const turnSchema = z.object({
  reply: z.string().min(1).max(2500),
  memory: memorySchema,
  action: z
    .enum(["none", "offer_call", "offer_gmail"])
    .describe(
      "offer_call immediately rings the first incoming call: firstIncomingCallRemaining must be true, calls open, and reply must announce ringing now. After any attempt use none and the phone icon. offer_gmail displays a connection card, never connects or sends mail. Otherwise none.",
    ),
});
export type AgentTurn = z.infer<typeof turnSchema>;
export const turnJsonSchema = z.toJSONSchema(turnSchema);
export const memoryJsonSchema = z.toJSONSchema(memorySchema);
export const WELCOME_MESSAGE =
  "Hey, I’m your new personal AI. What would you like to call me?";

// Refresh only an untouched introduction. Once a person has replied, their
// conversation remains a faithful record, including the question they answered.
export function refreshUntouchedWelcome(s: Session) {
  if (
    s.retiredAt ||
    s.messages.length !== 1 ||
    s.processed.length ||
    s.helping ||
    s.call.attempts ||
    s.call.status !== "never" ||
    s.gmail.status !== "unknown"
  )
    return;
  if (
    Object.values(s.profile).some(
      (field) => field.status !== "unknown" || field.value !== null,
    )
  )
    return;
  const first = s.messages[0];
  if (
    first.id === "welcome" &&
    first.role === "assistant" &&
    first.channel === "text" &&
    [
      "Hey, I’m your new personal AI. What should you call me?",
      "Hey, I’m your personal AI. Want to give me a name, or should I pick one?",
      "Hey, I’m your personal AI. Got a name in mind for me? No rush if not.",
    ].includes(first.text)
  )
    first.text = WELCOME_MESSAGE;
}
export function createSession(id: string): Session {
  const unknown = (): Field => ({ value: null, status: "unknown" });
  return {
    id,
    revision: 0,
    createdAt: Date.now(),
    profile: { agentName: unknown(), userName: unknown(), goal: unknown() },
    gmail: { status: "unknown" },
    call: { status: "never", attempts: 0 },
    helping: false,
    processed: [],
    messages: [
      {
        id: "welcome",
        role: "assistant",
        channel: "text",
        text: WELCOME_MESSAGE,
        at: Date.now(),
      },
    ],
  };
}
export function publicSession(s: Session): PublicSession {
  const {
    id: _id,
    processed: _processed,
    retiredAt: _retiredAt,
    gmail,
    ...rest
  } = s;
  const { encryptedTokens: _tokens, ...safeGmail } = gmail;
  return { ...rest, gmail: safeGmail };
}
export function addMessage(s: Session, message: Message) {
  if (!s.messages.some((m) => m.id === message.id)) s.messages.push(message);
}
export function applyMemory(s: Session, memory: MemoryPatch) {
  for (const key of ["agentName", "userName", "goal"] as const) {
    const patch = memory[key];
    if (!patch || patch.status === "unknown") continue;
    const value = patch.value?.trim();
    if (patch.status === "known" && !value) continue;
    s.profile[key] = {
      status: patch.status,
      value:
        patch.status === "known"
          ? Array.from(value!)
              .slice(0, key === "goal" ? 800 : 80)
              .join("")
          : null,
    };
  }
  if (
    memory.callPreference !== "unchanged" &&
    !(s.call.preference === "declined" && memory.callPreference === "deferred")
  ) {
    s.call.preference = memory.callPreference;
    if (
      ["declined", "deferred"].includes(memory.callPreference) &&
      s.call.status === "ringing"
    )
      endCall(
        s,
        "declined",
        memory.callPreference === "deferred"
          ? "Call postponed · staying in messages"
          : undefined,
      );
  }
  if (
    s.gmail.status !== "connected" &&
    memory.gmailPreference !== "unchanged" &&
    !(s.gmail.status === "declined" && memory.gmailPreference === "deferred")
  )
    s.gmail.status =
      memory.gmailPreference === "open" ? "offered" : memory.gmailPreference;
  if (memory.helping) s.helping = true;
}
export function canOfferIncomingCall(s: Session) {
  return (
    s.call.attempts === 0 &&
    s.call.status === "never" &&
    !["deferred", "declined"].includes(s.call.preference || "open")
  );
}
// A server-enforced demo cap is a transport transition, not a new user request.
// Keep its automatic text acknowledgment short; the saved conversation remains
// available for the user's next message without another setup question.
export function callLimitContinuation(event: Message): AgentTurn | undefined {
  if (
    event.role !== "event" ||
    event.channel !== "system" ||
    !event.id.startsWith("call-event:") ||
    ![
      VOICE_BUDGET_EVENT,
      VOICE_ACCOUNTING_ERROR_EVENT,
      VOICE_RENEWAL_ERROR_EVENT,
    ].includes(event.text)
  )
    return;
  return {
    reply:
      event.text === VOICE_BUDGET_EVENT
        ? "This demo has reached its available token spending limit for voice. Your conversation is saved."
        : "The voice connection couldn’t continue. Your conversation is saved here.",
    memory: {
      agentName: null,
      userName: null,
      goal: null,
      callPreference: "unchanged",
      gmailPreference: "unchanged",
      helping: false,
    },
    action: "none",
  };
}
export function applyTurn(s: Session, turn: AgentTurn, requestId: string) {
  if (
    s.processed.includes(requestId) ||
    s.messages.some((message) => message.id === `reply:${requestId}`)
  )
    return;
  applyMemory(s, turn.memory);
  addMessage(s, {
    id: `reply:${requestId}`,
    role: "assistant",
    text: turn.reply,
    channel: "text",
    at: Date.now(),
  });
  if (turn.action === "offer_call" && canOfferIncomingCall(s)) {
    s.call.status = "ringing";
    s.call.startedAt = Date.now();
    s.call.attempts++;
  }
  if (
    turn.action === "offer_gmail" &&
    !["connected", "declined", "deferred"].includes(s.gmail.status)
  )
    s.gmail.status = "offered";
}
export function endCall(
  s: Session,
  status: "ended" | "declined" | "missed" | "failed",
  text?: string,
) {
  s.call.status = status;
  s.call.endedAt = Date.now();
  const label =
    text ??
    {
      ended: "Audio call ended",
      declined: "Call declined · staying in messages",
      missed: "Missed audio call",
      failed: "Call couldn’t connect · staying in messages",
    }[status];
  const id = `call-event:${s.call.id ?? s.call.attempts}:${status}`;
  const existing = s.messages.find((message) => message.id === id);
  // Browser disconnect can win the lock just before authenticated usage saves
  // its terminal reason. Refine the generic event instead of losing that reason.
  if (existing?.text === "Audio call ended" && text) existing.text = label;
  addMessage(s, {
    id,
    role: "event",
    text: label,
    channel: "system",
    at: Date.now(),
  });
}
export function markCallUnavailable(s: Session) {
  if (["active", "connecting", "renewing"].includes(s.call.status)) return;
  s.call.attempts = Math.max(1, s.call.attempts);
  endCall(s, "failed");
}
