import test from "node:test";
import assert from "node:assert/strict";
import {
  liveHistory,
  liveHistoryTokenBound,
  LIVE_HISTORY_TOKEN_LIMIT,
  LIVE_HISTORY_MESSAGE_LIMIT,
} from "../src/lib/live-history";
import {
  liveConfiguration,
  liveOpeningInstruction,
} from "../src/lib/live-config";
import { createSession } from "../src/lib/domain";

test("Live history conservatively bounds Unicode and structural serialization while preserving newest text", () => {
  for (const text of [
    "a".repeat(30000),
    "你好😀é".repeat(8000),
    '\\"\n\t'.repeat(10000),
  ]) {
    const source = [
      { role: "user" as const, content: "oldest" },
      { role: "assistant" as const, content: text + "latest correction" },
      { role: "user" as const, content: "Use Thursday, not Friday." },
    ];
    const before = JSON.stringify(source);
    const actual = liveHistory(source);
    assert.ok(liveHistoryTokenBound(actual) <= LIVE_HISTORY_TOKEN_LIMIT);
    assert.equal(actual.length, 2);
    assert.equal(actual[1].content[0].text, source[2].content);
    assert.ok(actual[0].content[0].text.startsWith("[Earlier part omitted]\n"));
    assert.ok(actual[0].content[0].text.endsWith("latest correction"));
    assert.equal(
      Buffer.from(actual[0].content[0].text).toString(),
      actual[0].content[0].text,
      "no split UTF-16 surrogate",
    );
    assert.equal(
      JSON.stringify(source),
      before,
      "selection does not mutate durable input",
    );
  }
});

test("Live preserves short ordered history and bounds many empty messages", () => {
  const small = liveHistory([
    { role: "system", content: "Trusted reminder" },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
  ]);
  assert.deepEqual(
    small.map((m) => [m.role, m.content[0].text]),
    [
      ["developer", "Trusted reminder"],
      ["user", "Hi"],
      ["assistant", "Hello"],
    ],
  );
  assert.equal(small[2].content[0].type, "output_text");
  const many = liveHistory(
    Array.from({ length: 1000 }, () => ({
      role: "user" as const,
      content: "",
    })),
  );
  assert.ok(many.length > 0 && many.length <= LIVE_HISTORY_MESSAGE_LIMIT);
  assert.ok(liveHistoryTokenBound(many) <= LIVE_HISTORY_TOKEN_LIMIT);
  assert.deepEqual(liveHistory([]), []);
});

test("Live configuration bounds history separately while retaining profile and Gmail refusal", () => {
  const s = createSession("live-history-test");
  s.profile.agentName = { status: "known", value: "Appy" };
  s.profile.userName = { status: "known", value: "Riley" };
  s.profile.goal = { status: "known", value: "Keep track of my week" };
  s.gmail.status = "deferred";
  s.messages.push({
    id: "long",
    role: "user",
    channel: "voice",
    at: Date.now(),
    text: "你好😀".repeat(6000) + "Remember Thursday.",
  });
  const original = JSON.stringify(s);
  const config = liveConfiguration(s, true);
  assert.ok(liveHistoryTokenBound(config.input) <= LIVE_HISTORY_TOKEN_LIMIT);
  assert.match(config.instructions, /Appy/);
  assert.match(config.instructions, /Riley/);
  assert.match(config.instructions, /Keep track of my week/);
  assert.match(config.instructions, /"status":"deferred"/);
  assert.match(config.instructions, /gmail.status is exactly unknown/);
  assert.equal(JSON.stringify(s), original);
});

test("Live opening names the agent, skips answered questions and never regreets on renewal", () => {
  const s = createSession("live-opening-test");
  s.profile.agentName = { status: "known", value: "Appy" };
  assert.match(
    liveOpeningInstruction(s) || "",
    /Hey, it’s Appy\. What’s your name\?/,
  );
  s.profile.userName = { status: "known", value: "Riley" };
  assert.doesNotMatch(liveOpeningInstruction(s) || "", /What’s your name/);
  assert.match(
    liveOpeningInstruction(s) || "",
    /something you could use help with/,
  );
  s.profile.goal = { status: "deferred", value: null };
  assert.doesNotMatch(
    liveOpeningInstruction(s) || "",
    /something you could use help with/,
  );
  s.messages.push({
    id: "spoken",
    role: "user",
    channel: "voice",
    at: Date.now(),
    text: "My interview is Thursday.",
  });
  assert.match(
    liveOpeningInstruction(s) || "",
    /Say this opening now: "Hey, you’re back\. Ready to keep going\?"/,
  );
  assert.match(liveOpeningInstruction(s) || "", /Then pause and listen\./);
  assert.doesNotMatch(liveOpeningInstruction(s) || "", /Hey, it’s/);
  assert.equal(liveOpeningInstruction(s, true), undefined);
});
