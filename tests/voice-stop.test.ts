import test from "node:test";
import assert from "node:assert/strict";
import { pollVoiceStop, requestSupervisedStop } from "../src/lib/voice-stop";
function store() {
  const data = new Map<string, unknown>();
  return {
    data,
    read: async <T>(key: string) => (data.get(key) as T) || null,
    write: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("manual end is acknowledged only after the live supervisor initiates provider hangup", async () => {
  const s = store(),
    order: string[] = [];
  const request = requestSupervisedStop(
    s,
    "session",
    "call",
    async () => {
      order.push("fallback");
    },
    100,
    1,
  );
  await tick();
  const handled = await pollVoiceStop(
    s,
    "session",
    "call",
    () => true,
    async () => {
      order.push("provider hangup");
      return true;
    },
  );
  assert.equal(handled, true);
  assert.equal(await request, true);
  assert.deepEqual(order, ["provider hangup"]);
  assert.deepEqual(s.data.get("voice-stop:call"), {
    sessionId: "session",
    callId: "call",
    status: "ended",
  });
  assert.equal(
    await pollVoiceStop(
      s,
      "session",
      "call",
      () => true,
      async () => {
        throw new Error("repeated");
      },
    ),
    false,
  );
});
test("a request read after socket loss cannot create pre-close termination evidence", async () => {
  let finishRead!: (value: unknown) => void;
  let open = true,
    attempts = 0,
    writes = 0;
  const reading = new Promise<unknown>((resolve) => {
    finishRead = resolve;
  });
  const polling = pollVoiceStop(
    {
      read: async <T>() => (await reading) as T,
      write: async () => {
        writes++;
      },
    },
    "session",
    "call",
    () => open,
    async () => {
      attempts++;
      return true;
    },
  );
  open = false;
  finishRead({ sessionId: "session", callId: "call", status: "requested" });
  assert.equal(await polling, false);
  assert.equal(attempts, 0);
  assert.equal(writes, 0);
});
test("stop requests cannot target another session or call", async () => {
  const s = store();
  for (const request of [
    { sessionId: "other", callId: "call", status: "requested" },
    { sessionId: "session", callId: "other", status: "requested" },
    { sessionId: "session", callId: "call", status: "failed" },
  ]) {
    s.data.set("voice-stop:call", request);
    assert.equal(
      await pollVoiceStop(
        s,
        "session",
        "call",
        () => true,
        async () => {
          throw new Error("must not hang up");
        },
      ),
      false,
    );
  }
});
test("an unavailable supervisor uses bounded direct cleanup without an acknowledgment", async () => {
  const s = store();
  let fallback = 0;
  assert.equal(
    await requestSupervisedStop(
      s,
      "session",
      "call",
      async () => {
        fallback++;
      },
      10,
      1,
    ),
    false,
  );
  assert.equal(fallback, 1);
  assert.equal(
    (s.data.get("voice-stop:call") as { status: string }).status,
    "requested",
  );
});
test("provider404 or failed hangup does not become a successful supervisor acknowledgment", async () => {
  const s = store();
  let fallback = 0;
  const request = requestSupervisedStop(
    s,
    "session",
    "call",
    async () => {
      fallback++;
    },
    100,
    1,
  );
  await tick();
  await pollVoiceStop(
    s,
    "session",
    "call",
    () => true,
    async () => false,
  );
  assert.equal(await request, false);
  assert.equal(fallback, 1);
  assert.equal(
    (s.data.get("voice-stop:call") as { status: string }).status,
    "failed",
  );
});
test("stalled storage is bounded, and a late write cannot keep polling after fallback", async () => {
  let completeWrite!: () => void;
  const write = new Promise<void>((resolve) => {
    completeWrite = resolve;
  });
  let reads = 0,
    fallback = 0;
  const result = await requestSupervisedStop(
    {
      write: async () => write,
      read: async () => {
        reads++;
        return null;
      },
    },
    "session",
    "call",
    async () => {
      fallback++;
    },
    10,
    1,
  );
  assert.equal(result, false);
  assert.equal(fallback, 1);
  completeWrite();
  await tick();
  assert.equal(reads, 0);
});
