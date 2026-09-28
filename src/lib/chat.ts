import { z } from "zod";
import {
  addMessage,
  applyTurn,
  callLimitContinuation,
  type Session,
  type AgentTurn,
} from "./domain";
import {
  exclusive,
  getSession,
  saveSession,
  throttle,
  rawStore,
} from "./store";
import { generateTurn } from "./agent";
import { waitForVoiceSettlement } from "./voice-stop";

export const chatSchema = z
  .object({
    id: z.string().min(6).max(100),
    text: z.string().trim().min(1).max(2000).optional(),
    resume: z.boolean().optional(),
  })
  .refine((body) => (body.resume ? body.text === undefined : !!body.text));
type ChatInput = z.infer<typeof chatSchema>;
type Respond = (s: Session) => Promise<{ turn: AgentTurn }>;
export class ChatConflictError extends Error {}

export async function processChat(
  id: string,
  body: ChatInput,
  respond: Respond = generateTurn,
) {
  let settlingCallId: string | undefined;
  let settlement:
    Awaited<ReturnType<typeof waitForVoiceSettlement>> | undefined;
  if (body.resume || body.text) {
    const previous = await getSession(id);
    const event = previous?.messages.findLast(
      (m) => m.role === "event" && m.id.startsWith("call-event:"),
    );
    if (
      previous &&
      !previous.retiredAt &&
      previous.call.id &&
      ["ended", "failed"].includes(previous.call.status) &&
      !previous.processed.includes(body.id) &&
      !(body.resume && event && callLimitContinuation(event))
    ) {
      settlingCallId = previous.call.id;
      // Never wait under the session lock: final voice persistence needs it.
      settlement = await waitForVoiceSettlement(rawStore, id, settlingCallId, body.resume ? 5000 : 10000);
    }
  }
  return exclusive("session:" + id, async () => {
    const s = await getSession(id);
    if (!s) throw new Error("Session expired. Refresh to start again.");
    if (s.retiredAt)
      throw new Error("This conversation was restarted. Refresh to continue.");
    if (body.resume && settlingCallId && s.call.id !== settlingCallId) return s;
    const existing = s.messages.find((message) => message.id === body.id);
    if (
      existing &&
      (existing.role !== "user" ||
        existing.channel !== "text" ||
        body.resume ||
        existing.text !== body.text)
    )
      throw new ChatConflictError(
        "That message changed while it was sending. Send it as a new message.",
      );
    if (s.processed.includes(body.id)) return s;
    if (
      existing &&
      s.messages
        .slice(s.messages.indexOf(existing) + 1)
        .some(
          (message) => message.role === "user" || message.role === "assistant",
        )
    )
      throw new ChatConflictError(
        "A newer message has already continued this conversation. You can send this again as a new message.",
      );
    if (["active", "connecting", "renewing"].includes(s.call.status))
      throw new Error("End the call to continue in messages.");
    let resumedEvent: string | undefined;
    let continuation: AgentTurn | undefined;
    if (body.resume) {
      if (!["ended", "failed", "declined", "missed"].includes(s.call.status))
        throw new Error("There is no call to resume.");
      const at = s.messages.findLastIndex(
        (m) => m.role === "event" && m.id.startsWith("call-event:"),
      );
      const event = s.messages[at];
      // A late automatic continuation must not talk over a typed conversation
      // that already resumed, or attach itself to an unrelated Gmail event.
      if (
        !event ||
        s.processed.includes("resume:" + event.id) ||
        s.messages
          .slice(at + 1)
          .some((m) => m.channel === "text" && m.role !== "event")
      )
        return s;
      resumedEvent = "resume:" + event.id;
      continuation = callLimitContinuation(event);
      // An automatic greeting is optional. If accounting is still pending or
      // unverified, show the saved conversation without spending again or
      // replacing its context with a misleading budget-exhausted banner.
      if (
        !continuation &&
        s.call.id === settlingCallId &&
        settlement !== undefined &&
        settlement !== "settled"
      )
        return s;
    } else if (!body.text) throw new Error("Write a message first.");
    // Replays of successful requests do not consume another rate-limit slot.
    await throttle(id + ":chat", 30, 60000);
    if (!body.resume) {
      addMessage(s, {
        id: body.id,
        role: "user",
        text: body.text!,
        channel: "text",
        at: Date.now(),
      });
      await saveSession(s);
      if (settlement === "pending" && s.call.id === settlingCallId)
        throw new Error("Your call is still finishing. Your message is saved—try again in a moment.");
    }
    const { turn } = continuation ? { turn: continuation } : await respond(s);
    applyTurn(s, turn, body.id);
    s.processed.push(body.id);
    if (resumedEvent) s.processed.push(resumedEvent);
    await saveSession(s);
    return s;
  });
}
