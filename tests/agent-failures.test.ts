import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXT_RESERVATION_CENTS } from "../src/lib/text-limits";

// Each Node test file has its own process. Isolate its budget from local/demo data.
const originalCwd = process.cwd();
let directory = "";
let generateTurn: typeof import("../src/lib/agent").generateTurn;
let createSession: typeof import("../src/lib/domain").createSession;
let rawStore: typeof import("../src/lib/store").rawStore;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "persona-agent-faults-"));
  process.chdir(directory);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  delete process.env.OPENAI_API_KEY;
  process.env.TEXT_API_KEY = "synthetic-test-key";
  process.env.TEXT_BASE_URL = "https://provider.invalid/v1";
  process.env.TEXT_MODEL = "openai/gpt-5.4-mini";
  process.env.DEMO_BUDGET_USD = "5";
  ({ generateTurn } = await import("../src/lib/agent"));
  ({ createSession } = await import("../src/lib/domain"));
  ({ rawStore } = await import("../src/lib/store"));
});
after(async () => {
  process.chdir(originalCwd);
  if (directory) await rm(directory, { recursive: true, force: true });
});
const valid = {
  reply: "  Here’s a first draft.  ",
  memory: {
    agentName: null,
    userName: null,
    goal: null,
    callPreference: "unchanged",
    gmailPreference: "unchanged",
    helping: true,
  },
  action: "none",
};
const spent = async () =>
  (await rawStore.read<{ cents: number }>("budget"))?.cents || 0;

test("a clear standalone Gmail refusal is saved without contacting a provider or reserving usage", async (t) => {
  const before = await spent();
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("A consent acknowledgment must not call the provider");
  });
  const session = createSession("direct-refusal");
  session.messages.push({
    id: "refusal",
    role: "user",
    channel: "text",
    at: Date.now(),
    text: "Email isn't for me, let's leave that out.",
  });
  const result = await generateTurn(session);
  assert.equal(result.source, "app_guard");
  assert.equal(result.turn.memory.gmailPreference, "declined");
  assert.equal(result.turn.action, "none");
  assert.equal(await spent(), before);
});

test("a valid structured reply is trimmed and its confirmed cost reconciled", async (t) => {
  const before = await spent();
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      assert.equal(request.max_completion_tokens, 1800);
      assert.equal((await spent()) - before, TEXT_RESERVATION_CENTS);
      assert.equal(request.response_format.json_schema.strict, true);
      assert.ok(!request.messages[0].content.includes("synthetic-test-key"));
      return Response.json({
        choices: [{ message: { content: JSON.stringify(valid) } }],
        usage: { cost: 0.001 },
      });
    },
  );
  const result = await generateTurn(createSession("valid"));
  assert.equal(result.turn.reply, "Here’s a first draft.");
  assert.ok(Math.abs((await spent()) - before - 0.1) < 1e-8);
});

test("cache routing stays anonymous and stable across corrections", async (t) => {
  const keys: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      assert.match(request.prompt_cache_key, /^[a-f0-9]{64}$/);
      keys.push(request.prompt_cache_key);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(valid) } }],
        usage: { cost: 0 },
      });
    },
  );
  const s = createSession("cache-routing-session");
  await generateTurn(s);
  s.profile.userName = { status: "known", value: "Riley" };
  await generateTurn(s);
  await generateTurn(createSession("different-session"));
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

test("Together sends its schema and low-reasoning settings while reconciling verified token usage", async (t) => {
  const previous = { ...process.env };
  const before = await spent();
  process.env.TEXT_BASE_URL = "https://api.together.ai/v1";
  process.env.TEXT_MODEL = "zai-org/GLM-5.3-Flash";
  try {
    t.mock.method(
      globalThis,
      "fetch",
      async (url: unknown, init: RequestInit) => {
        assert.equal(url, "https://api.together.ai/v1/chat/completions");
        const body = JSON.parse(String(init.body));
        assert.equal(body.max_tokens, 1800);
        assert.equal(body.max_completion_tokens, undefined);
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.reasoning, undefined);
        assert.equal(body.service_tier, undefined);
        assert.match(body.prompt_cache_key, /^[a-f0-9]{64}$/);
        assert.ok(
          body.messages[0].content.includes(
            JSON.stringify(body.response_format.json_schema.schema),
          ),
        );
        assert.equal(
          body.messages.filter((m: { role: string }) => m.role === "system")
            .length,
          1,
        );
        assert.equal(body.messages.at(-1).role, "assistant"); // This synthetic session has only its untouched greeting.
        assert.ok(Math.abs((await spent()) - before - 1) < 1e-8);
        return Response.json({
          choices: [
            {
              message: { content: JSON.stringify(valid) },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 2000 },
          },
        });
      },
    );
    await generateTurn(createSession("together"));
    assert.ok(Math.abs((await spent()) - before - 0.031) < 1e-8);
  } finally {
    process.env = previous;
  }
});

test("a truncated model reply never changes memory even if the JSON is parseable", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          message: { content: JSON.stringify(valid) },
          finish_reason: "length",
        },
      ],
      usage: { cost: 0.001 },
    }),
  );
  await assert.rejects(
    generateTurn(createSession("truncated")),
    /reply didn’t come through/,
  );
});

test("network and timeout failures retain their hold and return only a recoverable message", async (t) => {
  const before = await spent();
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("private diagnostic with internal address");
  });
  await assert.rejects(
    generateTurn(createSession("network")),
    /^Error: I couldn’t reply just now\. Your message is saved—try again\.$/,
  );
  assert.ok(Math.abs((await spent()) - before - TEXT_RESERVATION_CENTS) < 1e-8);
});

test("a rate-limit rejection releases its hold and keeps a useful retry message", async (t) => {
  const before = await spent();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("provider internals", { status: 429 }),
  );
  await assert.rejects(generateTurn(createSession("rate")), /busy.*saved/i);
  assert.ok(Math.abs((await spent()) - before) < 1e-8);
});

test("an uncertain provider failure retains its hold without exposing provider details", async (t) => {
  const before = await spent();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("private diagnostic", { status: 503 }),
  );
  await assert.rejects(
    generateTurn(createSession("unavailable")),
    /couldn’t respond.*saved/i,
  );
  assert.ok(Math.abs((await spent()) - before - TEXT_RESERVATION_CENTS) < 1e-8);
});

test("malformed, missing, and schema-invalid model replies become recoverable errors", async (t) => {
  for (const content of [
    "{oops",
    null,
    JSON.stringify({ ...valid, reply: "   " }),
    JSON.stringify({ ...valid, action: "send_email" }),
  ]) {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        choices: [{ message: { content } }],
        usage: { cost: 0 },
      }),
    );
    await assert.rejects(
      generateTurn(createSession("malformed")),
      /^Error: That reply didn’t come through\. Your message is saved—try again\.$/,
    );
    t.mock.restoreAll();
  }
});

test("a non-JSON provider response does not leak parser errors and retains the unknown charge", async (t) => {
  const before = await spent();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("not-json private diagnostic"),
  );
  await assert.rejects(
    generateTurn(createSession("bad-envelope")),
    /reply didn’t come through.*saved/i,
  );
  assert.ok(Math.abs((await spent()) - before - TEXT_RESERVATION_CENTS) < 1e-8);
});

test("a null or non-object JSON provider envelope returns a friendly retry error", async (t) => {
  for (const envelope of [null, [], "private diagnostic", 123, false]) {
    const before = await spent();
    t.mock.method(globalThis, "fetch", async () => Response.json(envelope));
    await assert.rejects(
      generateTurn(createSession("invalid-envelope")),
      /^Error: That reply didn’t come through\. Your message is saved—try again\.$/,
    );
    assert.ok(
      Math.abs((await spent()) - before - TEXT_RESERVATION_CENTS) < 1e-8,
    );
    t.mock.restoreAll();
  }
});
