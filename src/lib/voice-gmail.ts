import type { Session } from "./domain";

// OAuth finishes in a separate window/instance. Keep the live model informed
// from saved application state without interrupting it or starting a response.
export function voiceGmailSync(
  sessionId: string,
  callId: string,
  read: () => Promise<Session | null>,
  canSend: () => boolean,
  send: (event: unknown) => void,
) {
  let previous: string | undefined;
  return async () => {
    if (!canSend()) return;
    const session = await read();
    if (
      !canSend() ||
      !session ||
      session.id !== sessionId ||
      session.retiredAt ||
      session.call.id !== callId ||
      !["active", "connecting"].includes(session.call.status)
    )
      return;
    const state = JSON.stringify({
      status: session.gmail.status,
      // Only a verified connected account has an authoritative address. Never
      // copy the stored token payload or retain an address after disconnect.
      ...(session.gmail.status === "connected" && session.gmail.email
        ? { email: session.gmail.email }
        : {}),
    });
    if (state === previous) return;
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Latest application-verified Gmail status: " +
              state +
              ". This replaces older Gmail state, including any previous account address. Use it on the next natural turn; do not interrupt, announce an update, or pitch Gmail again. Only connected means verified. Gmail remains optional account verification, with no inbox or sending access.",
          },
        ],
      },
    });
    previous = state;
  };
}
