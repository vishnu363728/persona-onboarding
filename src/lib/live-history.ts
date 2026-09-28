// Live startup input permits 128 messages / 8,192 tokens. Count serialized
// UTF-8 bytes as a conservative token bound, plus hidden message framing.
// This selects a view only; durable history and profile are never modified.
export const LIVE_HISTORY_TOKEN_LIMIT = 8192;
export const LIVE_HISTORY_MESSAGE_LIMIT = 128;
export const LIVE_HISTORY_SESSION_OVERHEAD = 256;
export const LIVE_HISTORY_MESSAGE_OVERHEAD = 64;
const OMITTED = "[Earlier part omitted]\n";

type HistoryMessage = {
  role: "user" | "assistant" | "developer" | "system";
  content: string;
};
export type LiveHistoryItem = {
  type: "message";
  role: "user" | "assistant" | "developer";
  content: [{ type: "input_text" | "output_text"; text: string }];
};

function item(
  message: HistoryMessage,
  text = message.content,
): LiveHistoryItem {
  return {
    type: "message",
    role: message.role === "system" ? "developer" : message.role,
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text,
      },
    ],
  };
}

export function liveHistoryTokenBound(history: LiveHistoryItem[]): number {
  return (
    LIVE_HISTORY_SESSION_OVERHEAD +
    history.reduce(
      (total, message) =>
        total +
        Buffer.byteLength(JSON.stringify(message), "utf8") +
        LIVE_HISTORY_MESSAGE_OVERHEAD,
      0,
    )
  );
}

export function liveHistory(
  messages: readonly HistoryMessage[],
): LiveHistoryItem[] {
  let available = LIVE_HISTORY_TOKEN_LIMIT - LIVE_HISTORY_SESSION_OVERHEAD;
  const selected: LiveHistoryItem[] = [];
  const cost = (value: LiveHistoryItem) =>
    Buffer.byteLength(JSON.stringify(value), "utf8") +
    LIVE_HISTORY_MESSAGE_OVERHEAD;
  for (
    let i = messages.length - 1;
    i >= 0 && selected.length < LIVE_HISTORY_MESSAGE_LIMIT;
    i--
  ) {
    const message = messages[i];
    const whole = item(message);
    const wholeCost = cost(whole);
    if (wholeCost <= available) {
      selected.unshift(whole);
      available -= wholeCost;
      continue;
    }
    // Keep the newest portion of the oldest fitting message. Array.from uses
    // Unicode code points, so the cut cannot split a surrogate pair.
    const points = Array.from(message.content);
    let low = 0,
      high = points.length;
    if (cost(item(message, OMITTED)) > available) break;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const partial = item(message, OMITTED + points.slice(-middle).join(""));
      if (cost(partial) <= available) low = middle;
      else high = middle - 1;
    }
    if (low > 0)
      selected.unshift(item(message, OMITTED + points.slice(-low).join("")));
    break;
  }
  return selected;
}
