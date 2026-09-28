// GPT-5.4 standard input/output: $2.50/$15 per million tokens. Cache savings
// reduce settlement, never the up-front allowance. With 18k UTF-16 characters
// of dialogue, bounded saved fields, the fixed prompt/schema, 1,800 completion
// tokens and a 4,096-token framing allowance, even the UTF-8 byte upper bound
// stays below 25 cents. Tests exercise the actual prompt and schema so growth
// cannot silently leave this reservation based on the former mini-model rate.
// https://developers.openai.com/api/docs/models/gpt-5.4
export const TEXT_RESERVATION_CENTS = 25;

import {
  textConfig,
  togetherRates,
  TEXT_OUTPUT_TOKEN_LIMIT,
} from "./text-provider";
import { turnJsonSchema, type Session } from "./domain";
import { textMessages } from "./prompt";
export function textReservationCents(session?: Session) {
  const config = textConfig();
  if (!config.together) return TEXT_RESERVATION_CENTS;
  const rates = togetherRates(config.model);
  if (!rates)
    throw new Error(
      "The selected text model needs a verified usage allowance.",
    );
  if (!session) return rates.reservationCents;
  // Bound this request, including full output, without assuming any cache hit.
  // UTF-8 bytes overestimate content tokens; 4096 covers role/template framing.
  // Count the schema twice: response_format plus Together's system copy.
  const bytes =
    textMessages(session, false, false).reduce(
      (sum, m) => sum + Buffer.byteLength(m.content, "utf8"),
      0,
    ) +
    2 * Buffer.byteLength(JSON.stringify(turnJsonSchema), "utf8") +
    4096;
  return Math.max(
    1,
    Math.ceil(
      (bytes * rates.input + TEXT_OUTPUT_TOKEN_LIMIT * rates.output) / 10000,
    ),
  );
}
