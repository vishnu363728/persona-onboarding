import type { VoiceEvent } from "./voice-events";

// Standard API rates verified 2026-09-28 against both official pricing and model
// pages. Rates are USD per million tokens, separately for each input modality.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
export const VOICE_PRICING_VERSION = "2026-09-28";
export const VOICE_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const realtimeRates = {
  text: 4,
  audio: 32,
  image: 5,
  cachedText: 0.4,
  cachedAudio: 0.4,
  cachedImage: 0.5,
  outputText: 24,
  outputAudio: 64,
};
const transcriptionRates = { text: 1.25, audio: 1.25, output: 5 };
const validCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const totalMatches = (
  usage: Record<string, unknown>,
  input: number,
  output: number,
) =>
  usage.total_tokens === undefined ||
  (validCount(usage.total_tokens) && usage.total_tokens === input + output);
// Integer nanodollars avoid accumulated floating point errors when rounding a
// complete call upward to cents. Every documented rate is exact at this scale.
function pricedNanodollars(terms: [number, number][]) {
  const cost = terms.reduce(
    (sum, [count, rate]) => sum + count * (rate * 1000),
    0,
  );
  return validCount(cost) ? cost : undefined;
}
function realtimeNanodollars(model: string, value: unknown) {
  if (model !== "gpt-realtime-2.1") return undefined;
  const usage = record(value),
    input = record(usage?.input_token_details),
    output = record(usage?.output_token_details);
  if (
    !usage ||
    !input ||
    !output ||
    !validCount(usage.input_tokens) ||
    !validCount(usage.output_tokens) ||
    !totalMatches(usage, usage.input_tokens, usage.output_tokens)
  )
    return undefined;
  const it = input.text_tokens,
    ia = input.audio_tokens,
    ii = input.image_tokens ?? 0,
    ot = output.text_tokens,
    oa = output.audio_tokens,
    cached = input.cached_tokens;
  if (
    !validCount(it) ||
    !validCount(ia) ||
    !validCount(ii) ||
    !validCount(ot) ||
    !validCount(oa) ||
    !validCount(cached) ||
    it + ia + ii !== usage.input_tokens ||
    ot + oa !== usage.output_tokens ||
    cached > usage.input_tokens
  )
    return undefined;
  // Reasoning is already part of text_tokens; adding it again double charges.
  if (
    output.reasoning_tokens !== undefined &&
    (!validCount(output.reasoning_tokens) || output.reasoning_tokens > ot)
  )
    return undefined;
  const detail = record(input.cached_tokens_details);
  // A zero cache total needs no split; positive cache usage must specify it.
  if (!detail && (cached !== 0 || input.cached_tokens_details !== undefined))
    return undefined;
  const ct = detail?.text_tokens ?? (cached === 0 ? 0 : undefined),
    ca = detail?.audio_tokens ?? (cached === 0 ? 0 : undefined),
    ci = detail?.image_tokens ?? 0;
  if (
    !validCount(ct) ||
    !validCount(ca) ||
    !validCount(ci) ||
    ct + ca + ci !== cached ||
    ct > it ||
    ca > ia ||
    ci > ii
  )
    return undefined;
  return pricedNanodollars([
    [it - ct, realtimeRates.text],
    [ia - ca, realtimeRates.audio],
    [ii - ci, realtimeRates.image],
    [ct, realtimeRates.cachedText],
    [ca, realtimeRates.cachedAudio],
    [ci, realtimeRates.cachedImage],
    [ot, realtimeRates.outputText],
    [oa, realtimeRates.outputAudio],
  ]);
}
function transcriptionNanodollars(model: string, value: unknown) {
  if (model !== VOICE_TRANSCRIPTION_MODEL) return undefined;
  const usage = record(value),
    input = record(usage?.input_token_details);
  if (
    !usage ||
    usage.type !== "tokens" ||
    !input ||
    !validCount(usage.input_tokens) ||
    !validCount(usage.output_tokens) ||
    !totalMatches(usage, usage.input_tokens, usage.output_tokens) ||
    !validCount(input.text_tokens) ||
    !validCount(input.audio_tokens) ||
    input.text_tokens + input.audio_tokens !== usage.input_tokens
  )
    return undefined;
  return pricedNanodollars([
    [input.text_tokens, transcriptionRates.text],
    [input.audio_tokens, transcriptionRates.audio],
    [usage.output_tokens, transcriptionRates.output],
  ]);
}
// Pure helpers also support offline replay of authenticated, retained usage.
// Unknown models, incomplete modality/cache splits and invalid counts have no
// price; callers must retain their reservation rather than treating that as $0.
export function realtimeUsageCostUsd(
  model: string,
  usage: unknown,
): number | undefined {
  const nanos = realtimeNanodollars(model, usage);
  return nanos === undefined ? undefined : nanos / 1e9;
}
export function transcriptionUsageCostUsd(
  model: string,
  usage: unknown,
): number | undefined {
  const nanos = transcriptionNanodollars(model, usage);
  return nanos === undefined ? undefined : nanos / 1e9;
}

// 1005 is a close frame without an optional status; 1006 normally means loss.
// Only our validated end_call, authenticated manual stop or configured call
// limit, initiated by the live supervisor, can explain 1006. Every refund needs pre-close
// termination and provider acknowledgment. Ledger completeness is also required.
export function verifiedVoiceClose(
  code: number,
  providerEnded: boolean,
  errored: boolean,
  controlledHangup = false,
  terminationStartedBeforeClose = false,
) {
  return (
    providerEnded &&
    !errored &&
    terminationStartedBeforeClose &&
    (code === 1000 || code === 1005 || (code === 1006 && controlledHangup))
  );
}

export function voiceUsageLedger(
  model: string,
  transcriptionModel = VOICE_TRANSCRIPTION_MODEL,
) {
  const pendingResponses = new Set<string>();
  const finishedResponses = new Set<string>();
  const pendingTranscripts = new Set<string>();
  const finishedTranscripts = new Set<string>();
  let unknown =
      model !== "gpt-realtime-2.1" ||
      transcriptionModel !== VOICE_TRANSCRIPTION_MODEL,
    reportedNanodollars = 0,
    sessionObserved = false;
  const addCost = (cost: number | undefined) => {
    if (cost === undefined || !validCount(reportedNanodollars + cost))
      unknown = true;
    else reportedNanodollars += cost;
  };
  return {
    observe(event: VoiceEvent) {
      if (event.type === "session.created") sessionObserved = true;
      if (event.type === "response.created") {
        if (event.response?.id) {
          if (!finishedResponses.has(event.response.id))
            pendingResponses.add(event.response.id);
        } else unknown = true;
      }
      if (event.type === "input_audio_buffer.committed") {
        if (event.item_id) {
          if (!finishedTranscripts.has(event.item_id))
            pendingTranscripts.add(event.item_id);
        } else unknown = true;
      }
      if (event.type === "response.done") {
        const id = event.response?.id;
        if (id && finishedResponses.has(id)) return;
        if (!id || !pendingResponses.delete(id)) unknown = true;
        if (id) finishedResponses.add(id);
        addCost(realtimeNanodollars(model, event.response?.usage));
      }
      if (
        event.type === "conversation.item.input_audio_transcription.completed"
      ) {
        const id = event.item_id;
        if (id && finishedTranscripts.has(id)) return;
        if (!id || !pendingTranscripts.delete(id)) unknown = true;
        if (id) finishedTranscripts.add(id);
        addCost(transcriptionNanodollars(transcriptionModel, event.usage));
      }
      if (
        event.type === "error" ||
        event.type === "conversation.item.input_audio_transcription.failed"
      )
        unknown = true;
    },
    get dollars() {
      return reportedNanodollars / 1e9;
    },
    snapshot() {
      return {
        pricingVersion: VOICE_PRICING_VERSION,
        transcriptionModel,
        reportedDollars: reportedNanodollars / 1e9,
        unknown,
        sessionObserved,
        finishedResponses: finishedResponses.size,
        pendingResponses: pendingResponses.size,
        finishedTranscripts: finishedTranscripts.size,
        pendingTranscripts: pendingTranscripts.size,
      };
    },
    // All observed work must have complete authenticated usage and a verified
    // provider shutdown. Round the whole call upward once (less than 1 cent of
    // rounding), without a blanket fee. Missing usage still retains the hold.
    settlementCents(cleanClose: boolean): number | undefined {
      if (
        !cleanClose ||
        unknown ||
        (!finishedResponses.size && !sessionObserved) ||
        pendingResponses.size ||
        pendingTranscripts.size
      )
        return undefined;
      return Math.ceil(reportedNanodollars / 1e7);
    },
  };
}
