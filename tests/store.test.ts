import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  exclusive,
  newSession,
  mutateSession,
  getSession,
  throttle,
} from "../src/lib/store";
test("concurrent memory updates serialize without dropping messages", async () => {
  const id = "test-" + randomUUID();
  await newSession(id);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      mutateSession(id, async (s) => {
        await new Promise((r) => setTimeout(r, 2));
        s.messages.push({
          id: String(i),
          role: "user",
          channel: "text",
          text: "test",
          at: i,
        });
      }),
    ),
  );
  const s = await getSession(id);
  assert.equal(s!.messages.length, 13);
  assert.equal(s!.revision, 13);
});
test("a failed operation releases the lock for the next request", async () => {
  const id = randomUUID();
  await assert.rejects(
    exclusive(id, async () => {
      throw new Error("failure");
    }),
  );
  assert.equal(await exclusive(id, async () => 42), 42);
});
test("rate limiting is atomic across concurrent requests", async () => {
  const id = randomUUID();
  const result = await Promise.allSettled(
    Array.from({ length: 8 }, () => throttle(id, 3, 60000)),
  );
  assert.equal(result.filter((x) => x.status === "fulfilled").length, 3);
});
