import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { realtimeConfiguration } from "../src/lib/voice-config";
import {
  createSession,
  endCall,
  addMessage,
  type Session,
} from "../src/lib/domain";
const cwd = process.cwd();
let directory: string;
let store: typeof import("../src/lib/store");
let renewal: typeof import("../src/lib/voice-renewal");
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "persona-renewal-"));
  process.chdir(directory);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL;
  process.env.DEMO_BUDGET_USD = "5";
  store = await import("../src/lib/store");
  renewal = await import("../src/lib/voice-renewal");
});
after(async () => {
  process.chdir(cwd);
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const s = createSession(crypto.randomUUID());
  s.profile.userName = { status: "known", value: "Sam" };
  s.call = {
    status: "active",
    attempts: 1,
    id: "old",
    startedAt: 123,
    direction: "incoming",
  };
  await store.saveSession(s);
  const order: string[] = [];
  const deps = {
    stop: async () => {
      order.push("stop");
    },
    receipt: async (_sessionId: string, _callId: string) => {
      order.push("receipt");
    },
    create: async (current: Session, _sdp: string, continuing: boolean) => {
      order.push("create");
      assert.equal(continuing, true);
      assert.equal(current.call.status, "renewing");
      return {
        contextContract: "synthetic-contract",
        callId: "new",
        sdp: "answer",
        reservation: randomUUID(),
        reservedCents: 200,
        model: "gpt-realtime-2.1",
        configuration: realtimeConfiguration(
          current,
          "gpt-realtime-2.1",
          false,
          true,
        ),
      };
    },
    hangup: async (id: string) => {
      order.push("hangup:" + id);
    },
  };
  return { s, order, deps };
}
test("renewal settles outside the session lock and preserves one ongoing conversation", async () => {
  const f = await fixture();
  f.deps.receipt = async () => {
    f.order.push("receipt");
    await store.mutateSession(f.s.id, (s) =>
      addMessage(s, {
        id: "final",
        role: "user",
        channel: "voice",
        text: "Keep it short",
        at: 123,
      }),
    );
  };
  const next = await renewal.renewVoiceCall(f.s.id, "old", "offer", f.deps);
  assert.deepEqual(f.order, ["stop", "receipt", "create"]);
  assert.equal(next.session.call.id, "new");
  assert.equal(next.session.call.previousId, "old");
  assert.equal(next.session.call.status, "active");
  assert.equal(next.session.call.startedAt, 123);
  assert.equal(next.session.call.attempts, 1);
  assert.equal(next.session.profile.userName.value, "Sam");
  assert.equal(next.session.messages.at(-1)!.text, "Keep it short");
});
test("reset or explicit hangup while old usage settles prevents a successor call", async () => {
  for (const action of ["reset", "end"]) {
    const f = await fixture();
    f.deps.receipt = async () => {
      await store.mutateSession(f.s.id, (s) => {
        if (action === "reset") s.retiredAt = Date.now();
        endCall(s, "ended");
      });
    };
    await assert.rejects(
      renewal.renewVoiceCall(f.s.id, "old", "offer", f.deps),
      /ended before/,
    );
    assert.ok(!f.order.includes("create"));
    assert.equal((await store.getSession(f.s.id))!.call.status, "ended");
  }
});
test("concurrent renewal cannot acquire the same live transport twice", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    renewal.renewVoiceCall(f.s.id, "old", "first", f.deps),
    renewal.renewVoiceCall(f.s.id, "old", "second", f.deps),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.order.filter((step) => step === "create").length, 1);
  assert.equal((await store.getSession(f.s.id))!.call.status, "active");
});
test("incomplete prior accounting fails as a connection issue without starting another leg", async () => {
  const f = await fixture();
  await store.rawStore.write("voice-usage:old", {
    sessionId: f.s.id,
    callId: "old",
    finalized: true,
    settledCents: null,
  });
  f.deps.receipt = renewal.waitForVoiceReceipt;
  await assert.rejects(
    renewal.renewVoiceCall(f.s.id, "old", "offer", f.deps),
    /usage could not be verified/,
  );
  const saved = (await store.getSession(f.s.id))!;
  assert.equal(saved.call.status, "failed");
  assert.match(saved.messages.at(-1)!.text, /connection renewal failed/);
  assert.ok(!f.order.includes("create"));
});
test("available reservation is atomic and never erases earlier uncertain holds", async () => {
  await store.rawStore.write("budget", {
    cents: 210.2,
    reservations: { historic: 150 },
  });
  const results = await Promise.allSettled([
    store.reserveAvailableBudget(51),
    store.reserveAvailableBudget(51),
  ]);
  const winners = results.filter((r) => r.status === "fulfilled");
  assert.equal(winners.length, 1);
  const hold = (
    winners[0] as PromiseFulfilledResult<{
      reservation: string;
      reservedCents: number;
    }>
  ).value;
  assert.equal(hold.reservedCents, 289);
  let budget = (await store.rawStore.read<{
    cents: number;
    reservations: Record<string, number>;
  }>("budget"))!;
  assert.equal(budget.cents, 499.2);
  assert.equal(budget.reservations.historic, 150);
  await store.settleBudget(hold.reservation, 9);
  budget = (await store.rawStore.read<typeof budget>("budget"))!;
  assert.equal(budget.cents, 219.2);
  assert.deepEqual(budget.reservations, { historic: 150 });
  await store.rawStore.write("budget", { cents: 450, reservations: {} });
  await assert.rejects(
    store.reserveAvailableBudget(51),
    /token spending limit/,
  );
  await store.rawStore.write("budget", {
    cents: 450,
    reservations: { historic: 150 },
  });
  await assert.rejects(
    store.reserveAvailableBudget(51),
    /enough token budget available/,
  );
});
