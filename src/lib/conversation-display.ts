import type { Message } from "./domain";

function gmailEvent(message: Message) {
  return message.role === "event" && /^Gmail\b/.test(message.text);
}

// Keep the full history for continuity, but show the final result of adjacent
// connection attempts instead of a stack of contradictory status updates.
export function conversationDisplayMessages(messages: Message[]) {
  return messages.flatMap((message, index) => {
    if (!gmailEvent(message)) return [message];
    const next = messages[index + 1];
    if (next && gmailEvent(next)) return [];
    const text = /^Gmail connected(?: · .*)?$/.test(message.text)
      ? "Gmail connected"
      : /^Gmail connection cancelled\b/.test(message.text)
        ? "Gmail left for later"
        : message.text;
    return [{ ...message, text }];
  });
}
