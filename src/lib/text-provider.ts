// Together serverless prices verified against the model catalog and /v1/models
// on 2026-09-28. Unknown models must be priced before using a smaller allowance.
// https://docs.together.ai/docs/serverless/models
export const TOGETHER_MODELS = {
  "zai-org/GLM-5.3": {
    input: 1.4,
    cachedInput: 0.26,
    output: 4.4,
    reservationCents: 13,
  },
  "zai-org/GLM-5.3-Flash": {
    input: 0.15,
    cachedInput: 0.03,
    output: 0.5,
    reservationCents: 2,
  },
  "deepseek-ai/DeepSeek-V4.1-Flash": {
    input: 0.3,
    cachedInput: 0.006,
    output: 1.2,
    reservationCents: 3,
  },
  "MiniMaxAI/MiniMax-M3": {
    input: 0.3,
    cachedInput: 0.06,
    output: 1.2,
    reservationCents: 3,
  },
} as const;

export const DEFAULT_TEXT_MODEL = "zai-org/GLM-5.3-Flash";
export const TEXT_OUTPUT_TOKEN_LIMIT = 1800;
export function togetherRates(model: string) {
  return TOGETHER_MODELS[model as keyof typeof TOGETHER_MODELS];
}
export function textConfig() {
  const base = (
    process.env.TEXT_BASE_URL || "https://api.together.ai/v1"
  ).replace(/\/$/, "");
  const together = [
    "https://api.together.ai/v1",
    "https://api.together.xyz/v1",
  ].includes(base);
  const directOpenAI = base === "https://api.openai.com/v1";
  return {
    base,
    together,
    directOpenAI,
    model:
      process.env.TEXT_MODEL || (together ? DEFAULT_TEXT_MODEL : "gpt-5.4"),
    key:
      process.env.TEXT_API_KEY ||
      (together ? process.env.TOGETHER_API_KEY : process.env.OPENAI_API_KEY),
  };
}
