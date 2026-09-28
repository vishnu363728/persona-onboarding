import test from "node:test";
import assert from "node:assert/strict";
import { textUsageDollars } from "../src/lib/text-usage";

test("text cached input is charged once at its discounted rate", () => {
  const usage = {
    prompt_tokens: 2000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 1500 },
  };
  assert.equal(
    textUsageDollars(usage, "gpt-5.4-mini", true),
    (500 * 0.75 + 1500 * 0.075 + 100 * 4.5) / 1e6,
  );
  assert.equal(
    textUsageDollars(
      { ...usage, prompt_tokens_details: undefined },
      "gpt-5.4-mini",
      true,
    ),
    (2000 * 0.75 + 100 * 4.5) / 1e6,
  );
});

test("provider billing takes precedence and unknown or invalid usage stays unsettled", () => {
  assert.equal(
    textUsageDollars({ cost: 0.123, prompt_tokens: 90000 }, "other", false),
    0.123,
  );
  assert.equal(textUsageDollars({ cost: 0 }, "other", false), 0);
  const usage = { prompt_tokens: 1000, completion_tokens: 100 };
  assert.equal(textUsageDollars(usage, "gpt-5.4-mini", false), undefined);
  assert.equal(textUsageDollars(usage, "unknown", true), undefined);
  for (const bad of [NaN, Infinity, -1, "0.01"])
    assert.equal(
      textUsageDollars({ cost: bad }, "gpt-5.4-mini", true),
      undefined,
    );
  for (const bad of [-1, 1001, 1.5, "100", Infinity])
    assert.equal(
      textUsageDollars(
        { ...usage, prompt_tokens_details: { cached_tokens: bad } },
        "gpt-5.4-mini",
        true,
      ),
      undefined,
    );
});

test("full GPT-5.4 uses its cached rate without assuming third-party or long-context prices", () => {
  const usage = {
    prompt_tokens: 3000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 2500 },
  };
  for (const model of ["gpt-5.4", "gpt-5.4-2026-03-05"])
    assert.equal(
      textUsageDollars(usage, model, true),
      (500 * 2.5 + 2500 * 0.25 + 200 * 15) / 1e6,
    );
  assert.equal(textUsageDollars(usage, "gpt-5.4", false), undefined);
  assert.equal(
    textUsageDollars({ ...usage, prompt_tokens: 272001 }, "gpt-5.4", true),
    undefined,
  );
  assert.equal(textUsageDollars({ ...usage, cost: 0.004 }, "gpt-5.4", false), 0.004);
});
