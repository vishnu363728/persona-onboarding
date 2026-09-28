import test from "node:test";
import assert from "node:assert/strict";
import { rawStore, reserveBudget, settleBudget } from "../src/lib/store";
test("usage settlement releases only the unused hold and is idempotent", async () => {
  const before = await rawStore.read<{ cents: number }>("budget");
  const start = before?.cents || 0;
  process.env.DEMO_BUDGET_USD = String((start + 100) / 100);
  const id = await reserveBudget(6);
  await settleBudget(id, 1);
  await settleBudget(id, 1);
  assert.equal(
    (await rawStore.read<{ cents: number }>("budget"))!.cents,
    start + 1,
  );
});
test("invalid or exhausted usage configuration fails closed", async () => {
  process.env.DEMO_BUDGET_USD = "not-a-number";
  await assert.rejects(reserveBudget(1), /configuration/);
  process.env.DEMO_BUDGET_USD = "0";
  await assert.rejects(reserveBudget(1), /token spending limit/);
  await assert.rejects(reserveBudget(-1), /Invalid/);
  delete process.env.DEMO_BUDGET_USD;
});
