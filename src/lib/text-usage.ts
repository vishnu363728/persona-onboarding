// Standard short-context rates, verified 2026-09-28:
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/docs/pricing
import { togetherRates } from "./text-provider";
const count = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function textUsageDollars(
  usage: unknown,
  model: string,
  directOpenAI: boolean | "together",
): number | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const u = usage as {
    cost?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    cached_tokens?: unknown;
  };
  // A provider's reported price already incorporates its discounts and fees.
  if (u.cost !== undefined)
    return typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0
      ? u.cost
      : undefined;
  // Never assume a third-party provider charges OpenAI's standard prices.
  if (!directOpenAI) return;
  if (directOpenAI === "together") {
    const rates = togetherRates(model);
    if (!rates) return;
    const cached =
      u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
    if (
      !count(u.prompt_tokens) ||
      !count(u.completion_tokens) ||
      !count(cached) ||
      cached > u.prompt_tokens
    )
      return;
    return (
      ((u.prompt_tokens - cached) * rates.input +
        cached * rates.cachedInput +
        u.completion_tokens * rates.output) /
      1e6
    );
  }
  const full = /^gpt-5\.4(?:-2026-03-05)?$/.test(model);
  const mini = /^gpt-5\.4-mini(?:-2026-03-17)?$/.test(model);
  if (!full && !mini) return;
  const rates = full
    ? { input: 2.5, cachedInput: 0.25, output: 15 }
    : { input: 0.75, cachedInput: 0.075, output: 4.5 };
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  if (!count(u.prompt_tokens) || !count(u.completion_tokens) || !count(cached))
    return;
  if (cached > u.prompt_tokens) return;
  // The app bounds history far below this; do not underprice a future caller
  // that crosses GPT-5.4's long-context pricing threshold.
  if (full && u.prompt_tokens > 272_000) return;
  return (
    ((u.prompt_tokens - cached) * rates.input +
      cached * rates.cachedInput +
      u.completion_tokens * rates.output) /
    1e6
  );
}
