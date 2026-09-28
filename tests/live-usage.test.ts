import test from "node:test";
import assert from "node:assert/strict";
import { liveUsageLedger, liveVoiceCostUsd } from "../src/lib/live-usage";

const make = (
  transport: "webrtc" | "websocket" = "webrtc",
  model = "gpt-live-1",
) => liveUsageLedger(model, { sessionId: "provider-live-id", transport });
const update = (seconds: unknown) => ({
  type: "session.usage.updated",
  usage: { seconds },
});
const close = (
  seconds: unknown,
  reason = "close_requested",
  id = "provider-live-id",
) => ({
  type: "session.closed",
  session: { id, model: "gpt-live-1" },
  usage: { seconds },
  reason,
});

test("Live seconds are cumulative, with a credited WebRTC initialization charge", () => {
  const ledger = make();
  assert.equal(ledger.dollars, 0.0125);
  ledger.observe(update(12));
  ledger.observe(update(15));
  ledger.observe(update(90));
  ledger.observe(update(90));
  ledger.observe(update(15));
  assert.equal(ledger.dollars, 0.075);
  assert.equal(ledger.snapshot().reportedSeconds, 90);
  assert.equal(
    ledger.settlementCents(),
    undefined,
    "running duration is not final usage",
  );
  ledger.observe(close(90));
  ledger.observe(close(90));
  assert.equal(
    ledger.settlementCents(),
    8,
    "round once to cents, not whole minutes",
  );
});

test("WebSocket has no WebRTC initialization charge and fractions use the documented rate", () => {
  assert.equal(liveVoiceCostUsd("gpt-live-1", 90, "webrtc"), 0.075);
  assert.equal(liveVoiceCostUsd("gpt-live-1", 0, "webrtc"), 0.0125);
  assert.equal(liveVoiceCostUsd("gpt-live-1", 0, "websocket"), 0);
  const ledger = make("websocket");
  ledger.observe(close(12.5));
  assert.equal(ledger.settlementCents(), 2);
  assert.ok(Math.abs(ledger.dollars - (12.5 / 60) * 0.05) < 1e-9);
});

test("matching final session.closed proves final usage for all documented close reasons", () => {
  for (const reason of [
    "close_requested",
    "expired",
    "content",
    "remote_hangup",
    "connection_lost",
  ]) {
    const ledger = make();
    ledger.observe({
      type: "session.started",
      session: { id: "provider-live-id", model: "gpt-live-1" },
    });
    ledger.observe(close(60, reason));
    assert.equal(ledger.settlementCents(), 5, reason);
    assert.equal(ledger.snapshot().finalConfirmed, true);
    assert.equal(ledger.snapshot().sessionStarted, true);
  }
});

test("missing final receipt, wrong session, regressing final duration, and invalid usage retain the hold", () => {
  const cases = [
    [update(60)],
    [close(60, "close_requested", "other-session")],
    [update(90), close(60)],
    [close(60, "unknown-reason")],
    [
      {
        type: "session.closed",
        usage: { seconds: 60 },
        reason: "close_requested",
      },
    ],
    [{ type: "session.usage.updated", usage: { duration_s: 60 } }, close(60)],
    ...[NaN, Infinity, -1, "60", undefined, Number.MAX_VALUE].map((value) => [
      update(value),
      close(60),
    ]),
  ];
  for (const events of cases) {
    const ledger = make();
    for (const event of events) ledger.observe(event);
    assert.equal(ledger.settlementCents(), undefined);
  }
  const unknown = make("webrtc", "unpriced-model");
  unknown.observe(close(60));
  assert.equal(unknown.settlementCents(), undefined);
});

test("client delegation costs are deduplicated and pending work blocks final settlement", () => {
  const ledger = make();
  ledger.markBackendPending("delegate-1");
  ledger.markBackendPending("delegate-1");
  ledger.observe(close(90));
  assert.equal(ledger.settlementCents(), undefined);
  ledger.addBackendDollars(0.02, "delegate-1");
  ledger.addBackendDollars(0.02, "delegate-1");
  ledger.markBackendPending("delegate-1");
  assert.equal(ledger.dollars, 0.095);
  assert.equal(ledger.settlementCents(), 10);
  assert.equal(ledger.snapshot().backendCalls, 1);
  assert.equal(ledger.snapshot().pendingBackendCalls, 0);
});

test("unknown, conflicting, or newly-started-after-close backend work cannot refund", () => {
  for (const cost of [undefined, NaN, Infinity, -1, Number.MAX_VALUE]) {
    const ledger = make();
    ledger.markBackendPending("delegate");
    ledger.addBackendDollars(cost, "delegate");
    ledger.observe(close(60));
    assert.equal(ledger.settlementCents(), undefined);
    assert.equal(ledger.snapshot().unknown, true);
    assert.equal(
      ledger.dollars,
      Infinity,
      "unknown usage immediately triggers the runtime guard",
    );
  }
  const conflict = make();
  conflict.addBackendDollars(0.01, "delegate");
  conflict.addBackendDollars(0.02, "delegate");
  conflict.observe(close(60));
  assert.equal(conflict.settlementCents(), undefined);
  const late = make();
  late.observe(close(60));
  late.markBackendPending("new-after-close");
  late.addBackendDollars(0, "new-after-close");
  assert.equal(late.settlementCents(), undefined);
});

test("stale usage after final receipt is harmless, but conflicting final or later higher usage is not", () => {
  const ledger = make();
  ledger.observe(close(60));
  ledger.observe(update(30));
  assert.equal(ledger.settlementCents(), 5);
  ledger.observe(update(61));
  assert.equal(ledger.settlementCents(), undefined);
  const conflicting = make();
  conflicting.observe(close(60));
  conflicting.observe(close(61));
  assert.equal(conflicting.settlementCents(), undefined);
});

test("unexpected hosted backend work cannot silently escape the client-backend allowance", () => {
  const ledger = make();
  ledger.observe({ type: "response.event", event: { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 50 } } } });
  ledger.observe(close(60));
  assert.equal(ledger.dollars, Infinity);
  assert.equal(ledger.settlementCents(), undefined);
});
