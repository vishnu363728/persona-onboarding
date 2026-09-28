import { createHash } from "node:crypto";
import { turnJsonSchema, turnSchema, type Session } from "./domain";
import { baseInstructions, contextMessages, verifiedContext } from "./prompt";
import { gmailReady } from "./agent";
import { textConfig, TEXT_OUTPUT_TOKEN_LIMIT } from "./text-provider";
import { textUsageDollars } from "./text-usage";

// Billed inside the parent voice reservation. No second global reservation can
// be made while voice holds the remaining allowance.
export async function generateLiveTurn(s: Session, bill: (dollars: number | undefined) => void) {
  const { base, model, key, directOpenAI, together } = textConfig();
  if (!key) throw new Error("The conversation backend is unavailable.");
  const schema = { ...turnJsonSchema, properties: { ...turnJsonSchema.properties,
    endCall: { type: "boolean" } }, required: [...(turnJsonSchema.required || []), "endCall"] };
  const system = baseInstructions("text") + `\nVOICE BACKEND: You are working silently behind a live voice conversation. Read its latest spoken turn and all supplied dialogue. Return the next useful spoken reply and save volunteered facts or corrections. The call is already connected; action offer_call is forbidden. Do not greet or repeat answered questions. Use the voice onboarding focus below. A general goal should advance to Gmail; a specific task should get useful help first. For offer_gmail, the application makes a card available only if Gmail has not been declined/deferred. When Gmail authorization is available, use the voice controls 'View Gmail connection', then 'Connect Gmail'. If authorization is unavailable, say connection is unavailable and keep helping; never direct them to a usable Connect button. Only set endCall true when the user's actual latest request explicitly asks to end this call or move to messages, never for quoted/hypothetical speech. Save final facts before ending, give a short acknowledgment, and ask no further question. Otherwise endCall false. Your reply will be communicated by the live voice model, not added to chat.\nReturn only JSON matching this schema:\n` + JSON.stringify(schema) + verifiedContext(s, gmailReady(), true, "voice");
  let response: Response;
  try {
    response = await fetch(base + "/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...contextMessages(s)],
        prompt_cache_key: createHash("sha256").update("persona-live-v1:" + s.id).digest("hex"),
        ...(directOpenAI ? { service_tier: "default" } : {}),
        ...(together ? { max_tokens: TEXT_OUTPUT_TOKEN_LIMIT, temperature: 0.5,
          ...(/\bGLM-|DeepSeek-V4/.test(model) ? { reasoning_effort: "low" } : { reasoning: { enabled: false } }) }
          : { max_completion_tokens: TEXT_OUTPUT_TOKEN_LIMIT }),
        ...(/gpt-(5|6)/.test(model) ? { reasoning_effort: "low" } : {}),
        response_format: { type: "json_schema", json_schema: { name: "voice_onboarding_turn", strict: true, schema } },
      }), signal: AbortSignal.timeout(20000),
    });
  } catch { bill(undefined); throw new Error("The conversation backend did not return a response."); }
  if (!response.ok) {
    bill([400, 401, 403, 404, 422, 429].includes(response.status) ? 0 : undefined);
    throw new Error("The conversation backend is temporarily unavailable.");
  }
  let data;
  try { data = await response.json(); }
  catch { bill(undefined); throw new Error("The conversation backend returned an incomplete response."); }
  bill(textUsageDollars(data.usage, model, together ? "together" : directOpenAI));
  if (data.choices?.[0]?.finish_reason === "length") throw new Error("Incomplete conversation result.");
  const parsed = JSON.parse(data.choices?.[0]?.message?.content);
  if (typeof parsed.endCall !== "boolean") throw new Error("Invalid conversation result.");
  return { turn: turnSchema.parse(parsed), endCall: parsed.endCall as boolean };
}
