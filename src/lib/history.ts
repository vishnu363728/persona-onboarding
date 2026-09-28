import type { Session } from "./domain";

export const HISTORY_MESSAGE_LIMIT = 240;
export const HISTORY_CHARACTER_LIMIT = 120_000;
export const MESSAGE_CHARACTER_LIMIT = 12_000;
export const CONTEXT_CHARACTER_LIMIT = 18_000;
const shortened = "\n[Long message shortened]\n";

// Keep both the beginning and latest detail, without splitting emoji pairs.
export function shortenMessage(text: string, limit: number) {
  if (text.length <= limit) return text;
  let head = Math.floor((limit - shortened.length) * 0.65);
  let tail = text.length - (limit - shortened.length - head);
  if (/[\uD800-\uDBFF]/.test(text[head - 1] || "")) head--;
  if (/[\uDC00-\uDFFF]/.test(text[tail] || "")) tail++;
  return text.slice(0, head) + shortened + text.slice(tail);
}

export function compactHistory(s: Session) {
  let characters = 0;
  for (const message of s.messages) {
    message.text = shortenMessage(message.text, MESSAGE_CHARACTER_LIMIT);
    characters += message.text.length;
  }
  let remove = 0;
  while (
    s.messages.length - remove > 1 &&
    (s.messages.length - remove > HISTORY_MESSAGE_LIMIT ||
      characters > HISTORY_CHARACTER_LIMIT)
  )
    characters -= s.messages[remove++].text.length;
  // Avoid presenting an orphan assistant reply at the start of a rolled window.
  if (remove) {
    while (
      remove < s.messages.length - 1 &&
      s.messages[remove].role === "assistant"
    )
      remove++;
    s.messages.splice(0, remove);
    s.historyTrimmed = (s.historyTrimmed || 0) + remove;
  }
}

export function selectContextMessages(s: Session) {
  let remaining = CONTEXT_CHARACTER_LIMIT;
  const result: { role: "assistant" | "user"; content: string }[] = [];
  const lastVoiceAssistant = s.messages.findLast(
    (m) => m.role === "assistant" && m.channel === "voice",
  );
  const ended = ["ended", "failed", "declined", "missed"].includes(
    s.call.status,
  );
  for (const message of s.messages.slice(-80).reverse()) {
    const prefix =
      message.role === "event"
        ? "[App event: "
        : message.interrupted
          ? "[Interrupted; user may not have heard all of this] "
          : ended && message.id === lastVoiceAssistant?.id
            ? "[Call ended after this; do not assume the user heard the full response] "
            : "";
    const content =
      prefix +
      shortenMessage(message.text, MESSAGE_CHARACTER_LIMIT) +
      (message.role === "event" ? "]" : "");
    // Keep a contiguous recent window; do not skip a large message and then
    // accidentally include unrelated older dialogue. The newest item always fits.
    if (content.length > remaining) break;
    result.push({
      role: message.role === "event" ? "user" : message.role,
      content,
    });
    remaining -= content.length;
  }
  return result.reverse();
}
