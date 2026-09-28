import test from "node:test";
import assert from "node:assert/strict";
import { acquireMicrophone } from "../src/components/voice-microphone";
import { voiceUsageLedger, verifiedVoiceClose } from "../src/lib/voice-usage";
const completed = {
  type: "response.done",
  response: {
    id: "r1",
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      input_token_details: {
        text_tokens: 800,
        audio_tokens: 200,
        image_tokens: 0,
        cached_tokens: 0,
      },
      output_token_details: { text_tokens: 20, audio_tokens: 80 },
    },
  },
};
function ledger() {
  const l = voiceUsageLedger("gpt-realtime-2.1");
  l.observe({ type: "response.created", response: { id: "r1" } });
  l.observe(completed);
  return l;
}
test("provider-confirmed normal close accepts an omitted code but rejects transport loss", () => {
  assert.equal(verifiedVoiceClose(1000, true, false, false, true), true);
  assert.equal(verifiedVoiceClose(1005, true, false, false, true), true);
  assert.equal(verifiedVoiceClose(1006, true, false), false);
  assert.equal(verifiedVoiceClose(1000, true, false), false);
  assert.equal(verifiedVoiceClose(1005, true, false), false);
  assert.equal(verifiedVoiceClose(1006, true, false, true), false);
  assert.equal(verifiedVoiceClose(1006, true, false, false, true), false);
  assert.equal(verifiedVoiceClose(1006, true, false, true, true), true);
  assert.equal(verifiedVoiceClose(1006, false, false, true), false);
  assert.equal(verifiedVoiceClose(1006, true, true, true), false);
  assert.equal(verifiedVoiceClose(1011, true, false, true), false);
  assert.equal(verifiedVoiceClose(1005, false, false), false);
  assert.equal(verifiedVoiceClose(1000, true, true), false);
});
test("authenticated complete voice usage settles conservatively and ignores replay", () => {
  const l = ledger();
  assert.ok(Math.abs(l.dollars - 0.0152) < 1e-10);
  l.observe(completed);
  assert.ok(Math.abs(l.dollars - 0.0152) < 1e-10);
  assert.equal(l.settlementCents(true), 2);
  assert.equal(l.settlementCents(false), undefined);
});
test("a verified idle renewal leg can settle zero without weakening incomplete-usage holds", () => {
  const l = voiceUsageLedger("gpt-realtime-2.1");
  assert.equal(l.settlementCents(true), undefined);
  l.observe({ type: "session.created" });
  assert.equal(l.settlementCents(false), undefined);
  assert.equal(l.settlementCents(true), 0);
  l.observe({ type: "input_audio_buffer.committed", item_id: "unreported" });
  assert.equal(l.settlementCents(true), undefined);
});
test("incomplete responses, pending transcriptions, unknown model and usage keep the hold", () => {
  const l = ledger();
  l.observe({ type: "response.created", response: { id: "unfinished" } });
  assert.equal(l.settlementCents(true), undefined);
  const transcription = ledger();
  transcription.observe({
    type: "input_audio_buffer.committed",
    item_id: "speech",
  });
  assert.equal(transcription.settlementCents(true), undefined);
  transcription.observe({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "speech",
    usage: {
      type: "tokens",
      input_tokens: 50,
      output_tokens: 10,
      input_token_details: { text_tokens: 0, audio_tokens: 50 },
    },
  });
  assert.equal(transcription.settlementCents(true), 2);
  const unknown = voiceUsageLedger("different-model");
  unknown.observe({ type: "response.created", response: { id: "r1" } });
  unknown.observe(completed);
  assert.equal(unknown.settlementCents(true), undefined);
  const malformed = ledger();
  malformed.observe({ type: "response.created", response: { id: "bad" } });
  malformed.observe({ type: "response.done", response: { id: "bad" } });
  assert.equal(malformed.settlementCents(true), undefined);
});
test("ignored microphone prompts time out and any late stream is stopped", async () => {
  let resolve!: (s: MediaStream) => void;
  let stopped = 0;
  const request = new Promise<MediaStream>((r) => {
    resolve = r;
  });
  const result = acquireMicrophone(
    () => request,
    new AbortController().signal,
    10,
  );
  await assert.rejects(result, /microphone prompt is still waiting/);
  resolve({
    getTracks: () => [{ stop: () => stopped++ }],
  } as unknown as MediaStream);
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, 1);
});
test("cancelling while microphone permission is pending stops a later grant", async () => {
  let resolve!: (s: MediaStream) => void;
  let stopped = 0;
  const request = new Promise<MediaStream>((r) => {
    resolve = r;
  });
  const controller = new AbortController();
  const result = acquireMicrophone(() => request, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  resolve({
    getTracks: () => [{ stop: () => stopped++ }],
  } as unknown as MediaStream);
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, 1);
});

test("replayed start/commit events do not reopen already-completed usage", () => {
  const l = ledger();
  l.observe({ type: "response.created", response: { id: "r1" } });
  assert.equal(l.settlementCents(true), 2);
  l.observe({ type: "input_audio_buffer.committed", item_id: "speech" });
  l.observe({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "speech",
    usage: {
      type: "tokens",
      input_tokens: 10,
      output_tokens: 1,
      input_token_details: { text_tokens: 0, audio_tokens: 10 },
    },
  });
  l.observe({ type: "input_audio_buffer.committed", item_id: "speech" });
  assert.equal(l.snapshot().pendingTranscripts, 0);
});
