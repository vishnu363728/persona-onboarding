import { turnSchema, turnJsonSchema, type Session } from "./domain";
import { createHash } from "node:crypto";
import { textMessages } from "./prompt";
import { textUsageDollars } from "./text-usage";
import { textReservationCents } from "./text-limits";
import { textConfig, TEXT_OUTPUT_TOKEN_LIMIT } from "./text-provider";
import { reserveBudget, settleBudget } from "./store";
import { getConversationGuard } from "./conversation-guards";
export const gmailReady = () =>
  !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.TOKEN_ENCRYPTION_KEY
  );
export const textReady = () => !!textConfig().key;
export async function generateTurn(s: Session) {
  const guardedTurn = getConversationGuard(s);
  if (guardedTurn)
    return {
      turn: guardedTurn,
      usage: { cost: 0 },
      source: "app_guard" as const,
    };
  if (!textReady())
    throw new Error(
      "The assistant is waiting for its API connection. Your message is saved; please try again once it’s connected.",
    );
  const { base, model, key, directOpenAI, together } = textConfig();
  const messages = textMessages(s, gmailReady(), !!process.env.OPENAI_API_KEY);
  // Together's chat pattern has one initial system message and ends with the
  // user's actual turn. Keep the large contract/schema prefix byte-identical;
  // the authoritative state follows that prefix, before normal dialogue.
  if (together) {
    const snapshot = messages.pop()!;
    messages[0].content +=
      "\nReturn only JSON matching this schema:\n" +
      JSON.stringify(turnJsonSchema) +
      snapshot.content.replace(
        "conversation above",
        "conversation that follows",
      );
  }
  const reservation = await reserveBudget(textReservationCents(s));
  const response = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      // Stable for this conversation, including memory corrections. No PII.
      prompt_cache_key: createHash("sha256")
        .update("persona-text-v3:" + s.id)
        .digest("hex"),
      ...(directOpenAI ? { service_tier: "default" } : {}),
      ...(together
        ? {
            max_tokens: TEXT_OUTPUT_TOKEN_LIMIT,
            ...(/\bGLM-|DeepSeek-V4/.test(model)
              ? { reasoning_effort: "low" }
              : { reasoning: { enabled: false } }),
            temperature: 0.7,
          }
        : { max_completion_tokens: TEXT_OUTPUT_TOKEN_LIMIT }),
      ...(/gpt-(5|6)/.test(model)
        ? { reasoning_effort: process.env.TEXT_REASONING_EFFORT || "low" }
        : {}),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "onboarding_turn",
          strict: true,
          schema: turnJsonSchema,
        },
      },
    }),
    signal: AbortSignal.timeout(25000),
  }).catch(() => {
    // No confirmed response means unknown usage; preserve its reservation.
    throw new Error(
      "I couldn’t reply just now. Your message is saved—try again.",
    );
  });
  if (!response.ok) {
    if ([400, 401, 403, 404, 422, 429].includes(response.status))
      await settleBudget(reservation, 0);
    console.error("Text API status", response.status);
    throw new Error(
      response.status === 429
        ? "The assistant is busy. Your message is saved—try again in a moment."
        : "The assistant couldn’t respond just now. Your message is saved; try again.",
    );
  }
  const unfinished =
    "That reply didn’t come through. Your message is saved—try again.";
  let data;
  try {
    data = await response.json();
  } catch {
    // Unknown provider failures keep the reservation and never expose raw payloads.
    throw new Error(unfinished);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(unfinished);
  const reported = textUsageDollars(
    data.usage,
    model,
    together ? "together" : directOpenAI,
  );
  if (reported !== undefined) await settleBudget(reservation, reported * 100);
  const content = data.choices?.[0]?.message?.content;
  try {
    if (data.choices?.[0]?.finish_reason === "length")
      throw new Error("Truncated reply");
    const turn = turnSchema.parse(JSON.parse(content));
    if (!turn.reply.trim()) throw new Error("Empty reply");
    return {
      turn: { ...turn, reply: turn.reply.trim() },
      usage: data.usage,
      source: "model" as const,
    };
  } catch {
    throw new Error(unfinished);
  }
}
