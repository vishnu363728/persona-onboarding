import test from "node:test";
import assert from "node:assert/strict";
import { textUsageDollars } from "../src/lib/text-usage";
import {
  textConfig,
  TOGETHER_MODELS,
  TEXT_OUTPUT_TOKEN_LIMIT,
} from "../src/lib/text-provider";
import { createSession, turnJsonSchema } from "../src/lib/domain";
import { textMessages } from "../src/lib/prompt";
import { CONTEXT_CHARACTER_LIMIT } from "../src/lib/history";
import { textReservationCents } from "../src/lib/text-limits";

test("Together charges only the uncached portion at the full input rate", () => {
  for (const [model, rate] of Object.entries(TOGETHER_MODELS)) {
    const usage = {
      prompt_tokens: 4000,
      completion_tokens: 250,
      cached_tokens: 3000,
    };
    const expected =
      (1000 * rate.input + 3000 * rate.cachedInput + 250 * rate.output) / 1e6;
    assert.equal(textUsageDollars(usage, model, "together"), expected);
    assert.equal(
      textUsageDollars(
        {
          ...usage,
          cached_tokens: undefined,
          prompt_tokens_details: { cached_tokens: 3000 },
        },
        model,
        "together",
      ),
      expected,
    );
    assert.equal(textUsageDollars(usage, model, false), undefined);
    assert.equal(
      textUsageDollars({ ...usage, cost: 0.0002 }, model, "together"),
      0.0002,
    );
    for (const bad of [-1, 4001, NaN, 0.5, "3000"])
      assert.equal(
        textUsageDollars({ ...usage, cached_tokens: bad }, model, "together"),
        undefined,
      );
  }
  assert.equal(
    textUsageDollars(
      { prompt_tokens: 100, completion_tokens: 1 },
      "unknown",
      "together",
    ),
    undefined,
  );
});

test("Together allowance covers bounded Unicode history, escaped facts, duplicate schema, and maximum output", () => {
  for (const character of ["漢", "🌱", "\u0001", "\\"]) {
    const s = createSession("together-bound");
    for (const key of ["agentName", "userName", "goal"] as const)
      s.profile[key] = {
        status: "known",
        value: "\u0001".repeat(key === "goal" ? 800 : 80),
      };
    s.gmail = { status: "connected", email: "漢".repeat(310) + "@x.test" };
    const value = character
      .repeat(CONTEXT_CHARACTER_LIMIT)
      .slice(0, CONTEXT_CHARACTER_LIMIT);
    s.messages = [value.slice(0, 12000), value.slice(12000)].map((text, i) => ({
      id: String(i),
      role: "user",
      channel: "text",
      at: i,
      text,
    }));
    const messages = textMessages(s, true, true);
    const inputBound =
      messages.reduce((total, m) => total + Buffer.byteLength(m.content), 0) +
      2 * Buffer.byteLength(JSON.stringify(turnJsonSchema)) +
      4096;
    for (const rates of Object.values(TOGETHER_MODELS)) {
      const cents =
        (inputBound * rates.input + TEXT_OUTPUT_TOKEN_LIMIT * rates.output) /
        10000;
      assert.ok(
        cents <= rates.reservationCents,
        `${cents} exceeds ${rates.reservationCents}`,
      );
    }
  }
});

test("Together does not fall back to a voice key, and only exact known endpoints get Together rates", () => {
  const previous = { ...process.env };
  try {
    delete process.env.TEXT_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-voice-key";
    process.env.TEXT_BASE_URL = "https://api.together.ai/v1/";
    assert.equal(textConfig().key, undefined);
    assert.equal(textConfig().together, true);
    process.env.TEXT_BASE_URL = "https://api.together.ai.evil.test/v1";
    assert.equal(textConfig().together, false);
  } finally {
    process.env = previous;
  }
});

test("per-request reservations include maximum output without charging every short chat for maximal history", () => {
  const previous = { ...process.env };
  try {
    process.env.TEXT_BASE_URL = "https://api.together.ai/v1";
    for (const model of Object.keys(TOGETHER_MODELS)) {
      process.env.TEXT_MODEL = model;
      const small = createSession("small");
      const shortHold = textReservationCents(small);
      const large = createSession("large");
      large.messages = [0, 1].map((i) => ({
        id: String(i),
        role: "user",
        channel: "text",
        at: i,
        text: "漢".repeat(8500),
      }));
      assert.ok(shortHold >= 1);
      assert.ok(textReservationCents(large) > shortHold);
      assert.ok(textReservationCents(large) <= textReservationCents());
    }
    process.env.TEXT_MODEL = "unpriced";
    assert.throws(
      () => textReservationCents(createSession("unknown")),
      /verified usage allowance/,
    );
  } finally {
    process.env = previous;
  }
});
