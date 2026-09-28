import test from "node:test";
import assert from "node:assert/strict";
import { createSession, turnJsonSchema } from "../src/lib/domain";
import { textMessages } from "../src/lib/prompt";
import { CONTEXT_CHARACTER_LIMIT } from "../src/lib/history";
import { TEXT_RESERVATION_CENTS } from "../src/lib/text-limits";

// GPT-5.4's byte-level tokenizer cannot produce more ordinary content tokens
// than UTF-8 bytes. Count actual decoded message content, not HTTP JSON escapes;
// the verified-state system message itself contains JSON and is counted intact.
// Add the full output cap and a conservative allowance for message/schema framing.
function upperBoundCents(messages: ReturnType<typeof textMessages>) {
  const inputTokens =
    messages.reduce(
      (sum, message) => sum + Buffer.byteLength(message.content, "utf8"),
      0,
    ) +
    Buffer.byteLength(JSON.stringify(turnJsonSchema), "utf8") +
    4096;
  return (inputTokens * 2.5 + 1800 * 15) / 10000;
}

test("full-model text reservation covers maximal Unicode history and escaped saved facts", () => {
  assert.equal(TEXT_RESERVATION_CENTS, 25);
  for (const character of ["漢", "🌱", "\u0001", "\\"]) {
    const s = createSession("unicode-bound");
    s.profile.agentName = { status: "known", value: "\u0001".repeat(80) };
    s.profile.userName = { status: "known", value: "\u0001".repeat(80) };
    s.profile.goal = { status: "known", value: "\u0001".repeat(800) };
    s.gmail = { status: "connected", email: "漢".repeat(310) + "@x.test" };
    const repeated = character
      .repeat(CONTEXT_CHARACTER_LIMIT)
      .slice(0, CONTEXT_CHARACTER_LIMIT);
    s.messages = [
      {
        id: "first",
        role: "user",
        channel: "text",
        text: repeated.slice(0, 12000),
        at: 1,
      },
      {
        id: "latest",
        role: "user",
        channel: "text",
        text: repeated.slice(12000),
        at: 2,
      },
    ];
    const bound = upperBoundCents(textMessages(s, true, true));
    assert.ok(
      bound > 6,
      "the former mini-model hold does not cover this request",
    );
    assert.ok(
      bound <= TEXT_RESERVATION_CENTS,
      `worst-case cost${bound} cents exceeds the hold`,
    );
  }
});

test("many short messages plus actual fixed instructions/schema fit the same reservation", () => {
  const s = createSession("many-turns-bound");
  s.messages = Array.from({ length: 80 }, (_, i) => ({
    id: String(i),
    role: i % 2 ? "assistant" : "user",
    channel: "text",
    text: "漢".repeat(225),
    at: i,
  }));
  const messages = textMessages(s, false, false);
  assert.equal(messages.length, 82);
  assert.ok(upperBoundCents(messages) <= TEXT_RESERVATION_CENTS);
});
