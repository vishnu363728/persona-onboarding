import test from "node:test";
import assert from "node:assert/strict";
import {
  realtimeUsageCostUsd,
  transcriptionUsageCostUsd,
  voiceUsageLedger,
  verifiedVoiceClose,
} from "../src/lib/voice-usage";
import { voiceEventHandler, type VoiceEvent } from "../src/lib/voice-events";
const model = "gpt-realtime-2.1";
function usage() {
  return {
    total_tokens: 1300,
    input_tokens: 1200,
    output_tokens: 100,
    input_token_details: {
      text_tokens: 800,
      audio_tokens: 300,
      image_tokens: 100,
      cached_tokens: 620,
      cached_tokens_details: {
        text_tokens: 500,
        audio_tokens: 100,
        image_tokens: 20,
      },
    },
    output_token_details: {
      text_tokens: 20,
      audio_tokens: 80,
      reasoning_tokens: 10,
    },
  };
}
function completed(value = usage()): VoiceEvent {
  return {
    type: "response.done",
    response: { id: "response", status: "completed", usage: value },
  };
}
test("prices each uncached/cached modality and counts reasoning only once", () => {
  assert.equal(realtimeUsageCostUsd(model, usage()), 0.01385);
  const uncached = usage();
  uncached.input_token_details.cached_tokens = 0;
  uncached.input_token_details.cached_tokens_details = {
    text_tokens: 0,
    audio_tokens: 0,
    image_tokens: 0,
  };
  assert.equal(realtimeUsageCostUsd(model, uncached), 0.0189);
});
test("invalid cache splits or unknown modalities never silently discount usage", () => {
  const cases: unknown[] = [];
  for (const change of [
    (u: ReturnType<typeof usage>) => {
      u.input_token_details.cached_tokens = 621;
    },
    (u: ReturnType<typeof usage>) => {
      u.input_token_details.cached_tokens_details.text_tokens = 801;
    },
    (u: ReturnType<typeof usage>) => {
      u.input_token_details.cached_tokens_details.audio_tokens = -1;
    },
    (u: ReturnType<typeof usage>) => {
      u.input_token_details.cached_tokens_details.image_tokens = 0.5;
    },
    (u: ReturnType<typeof usage>) => {
      u.input_tokens++;
      u.total_tokens++;
    },
    (u: ReturnType<typeof usage>) => {
      u.output_tokens++;
      u.total_tokens++;
    },
    (u: ReturnType<typeof usage>) => {
      u.total_tokens++;
    },
    (u: ReturnType<typeof usage>) => {
      u.output_token_details.reasoning_tokens = 21;
    },
  ]) {
    const u = usage();
    change(u);
    cases.push(u);
  }
  cases.push({
    ...usage(),
    input_token_details: {
      text_tokens: 800,
      audio_tokens: 300,
      image_tokens: 100,
    },
  });
  cases.push({
    ...usage(),
    input_token_details: {
      ...usage().input_token_details,
      cached_tokens_details: undefined,
    },
  });
  cases.push(
    null,
    {},
    { ...usage(), input_tokens: "1200" },
    { ...usage(), input_tokens: Number.MAX_VALUE },
  );
  for (const value of cases)
    assert.equal(realtimeUsageCostUsd(model, value), undefined);
  assert.equal(realtimeUsageCostUsd("future-model", usage()), undefined);
});
test("zero cached total needs no split but contradictory zero-cache metadata is invalid", () => {
  const u = {
    ...usage(),
    input_token_details: {
      text_tokens: 800,
      audio_tokens: 300,
      image_tokens: 100,
      cached_tokens: 0,
    },
  };
  assert.equal(realtimeUsageCostUsd(model, u), 0.0189);
  assert.equal(
    realtimeUsageCostUsd(model, {
      ...u,
      input_token_details: {
        ...u.input_token_details,
        cached_tokens_details: { text_tokens: 1, audio_tokens: 0 },
      },
    }),
    undefined,
  );
});
test("mini transcription uses its current text/audio rates and separate output rate", () => {
  const u = {
    type: "tokens",
    total_tokens: 112,
    input_tokens: 84,
    input_token_details: { text_tokens: 0, audio_tokens: 84 },
    output_tokens: 28,
  };
  assert.equal(
    transcriptionUsageCostUsd("gpt-4o-mini-transcribe", u),
    0.000245,
  );
  assert.equal(
    transcriptionUsageCostUsd("gpt-4o-mini-transcribe", {
      ...u,
      input_token_details: { text_tokens: 4, audio_tokens: 80 },
    }),
    0.000245,
  );
  for (const invalid of [
    { ...u, input_token_details: undefined },
    { ...u, input_token_details: { text_tokens: 0, audio_tokens: 83 } },
    { ...u, output_tokens: -1 },
    { ...u, type: "duration" },
    { ...u, total_tokens: 1 },
  ])
    assert.equal(
      transcriptionUsageCostUsd("gpt-4o-mini-transcribe", invalid),
      undefined,
    );
  assert.equal(transcriptionUsageCostUsd("other-transcriber", u), undefined);
});
test("complete usage rounds upward once and incomplete usage retains the hold even after tool hangup", () => {
  const ledger = voiceUsageLedger(model);
  ledger.observe({ type: "response.created", response: { id: "response" } });
  ledger.observe(completed());
  assert.equal(ledger.settlementCents(true), 2);
  ledger.observe(completed());
  assert.equal(ledger.dollars, 0.01385);
  assert.equal(
    ledger.settlementCents(verifiedVoiceClose(1006, true, false)),
    undefined,
  );
  assert.equal(
    ledger.settlementCents(verifiedVoiceClose(1006, true, false, true, true)),
    2,
  );
  ledger.observe({
    type: "input_audio_buffer.committed",
    item_id: "late-input",
  });
  assert.equal(
    ledger.settlementCents(verifiedVoiceClose(1006, true, false, true, true)),
    undefined,
  );
  const invalid = voiceUsageLedger(model);
  invalid.observe({ type: "response.created", response: { id: "response" } });
  invalid.observe({
    type: "response.done",
    response: { id: "response", usage: { input_tokens: 0, output_tokens: 0 } },
  });
  assert.equal(invalid.snapshot().unknown, true);
  assert.equal(
    invalid.settlementCents(verifiedVoiceClose(1006, true, false, true, true)),
    undefined,
  );
});
test("an exact-cent aggregate does not gain another cent from floating point summation", () => {
  const ledger = voiceUsageLedger(model);
  for (let i = 0; i < 10; i++) {
    const u = {
      input_tokens: 250,
      output_tokens: 0,
      input_token_details: {
        text_tokens: 250,
        audio_tokens: 0,
        cached_tokens: 0,
      },
      output_token_details: { text_tokens: 0, audio_tokens: 0 },
    };
    ledger.observe({ type: "response.created", response: { id: String(i) } });
    ledger.observe({
      type: "response.done",
      response: { id: String(i), usage: u },
    });
  }
  assert.equal(ledger.dollars, 0.01);
  assert.equal(ledger.settlementCents(true), 1);
});
test("the stop guard uses the cache-aware ledger and stops on unknown usage", async () => {
  const ledger = voiceUsageLedger(model),
    stops: string[] = [];
  const handle = voiceEventHandler({
    save: async () => {},
    send: () => {},
    schedule: () => () => {},
    stop: async (reason) => {
      stops.push(reason);
    },
    cost: () => (ledger.snapshot().unknown ? Infinity : ledger.dollars),
  });
  const e: VoiceEvent = {
    type: "response.done",
    response: {
      id: "cached",
      usage: {
        input_tokens: 32000,
        output_tokens: 0,
        input_token_details: {
          text_tokens: 0,
          audio_tokens: 32000,
          cached_tokens: 32000,
          cached_tokens_details: { text_tokens: 0, audio_tokens: 32000 },
        },
        output_token_details: { text_tokens: 0, audio_tokens: 0 },
      },
    },
  };
  ledger.observe({ type: "response.created", response: { id: "cached" } });
  ledger.observe(e);
  await handle(e);
  assert.equal(ledger.dollars, 0.0128);
  assert.equal(
    stops.length,
    0,
    "uncached $1.024 estimate must not override cached $0.0128 usage",
  );
  const unknown: VoiceEvent = {
    type: "response.done",
    response: { id: "unknown" },
  };
  ledger.observe({ type: "response.created", response: { id: "unknown" } });
  ledger.observe(unknown);
  await handle(unknown);
  assert.deepEqual(stops, ["Call ended · usage tracking unavailable"]);
  assert.equal(ledger.settlementCents(true), undefined);
});
