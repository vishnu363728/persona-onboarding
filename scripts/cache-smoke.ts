/** Three paid text turns through the real provider and the unchanged $5 ledger. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { generateTurn } from "../src/lib/agent";
import { createSession, addMessage, applyTurn } from "../src/lib/domain";
import { rawStore } from "../src/lib/store";
import { textMessages } from "../src/lib/prompt";

async function main() {
  const readBudget = async () =>
    (await rawStore.read<{ cents: number }>("budget"))?.cents || 0;
  const before = await readBudget();
  const s = createSession("cache-smoke-" + crypto.randomUUID());
  const turns = [
    "Call yourself Nova. I'm Sam. No calls or Gmail. Help me practice a backend interview. Ask me one question.",
    "Actually, call me Riley. I would use a token bucket stored in Redis. What is the biggest tradeoff?",
    "Keep calling me Riley. Change the goal to preparing for a frontend interview; ask one relevant practice question.",
  ];
  const results = [];
  let previousPrompt: ReturnType<typeof textMessages> | undefined;
  for (const [i, text] of turns.entries()) {
    if ((await readBudget()) + 6 > 490)
      throw new Error("Preserving the remaining demo allowance.");
    addMessage(s, {
      id: "user-" + i,
      role: "user",
      channel: "text",
      at: Date.now(),
      text,
    });
    const prompt = textMessages(s, true, true);
    if (previousPrompt)
      assert.deepEqual(
        prompt.slice(0, previousPrompt.length - 1),
        previousPrompt.slice(0, -1),
      );
    const result = await generateTurn(s);
    applyTurn(s, result.turn, "reply-" + i);
    const usage = result.usage;
    results.push({
      user: text,
      assistant: result.turn.reply,
      usage,
      profile: structuredClone(s.profile),
    });
    previousPrompt = prompt;
    console.log(
      JSON.stringify({
        turn: i + 1,
        inputTokens: usage?.prompt_tokens,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
        name: s.profile.userName.value,
      }),
    );
  }
  const checks = {
    cacheHitAfterMemoryChanged: results
      .slice(1)
      .some((r) => r.usage?.prompt_tokens_details?.cached_tokens > 0),
    correctedName: s.profile.userName.value === "Riley",
    correctedGoal: /frontend/i.test(s.profile.goal.value || ""),
    refusalPreserved:
      s.call.preference === "declined" && s.gmail.status === "declined",
    noCall: s.call.attempts === 0,
    stableConversationPrefix: true,
  };
  await mkdir("output/qa", { recursive: true });
  await writeFile(
    "output/qa/cache-smoke.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        calls: 3,
        checks,
        results,
        ledgerBeforeUSD: before / 100,
        ledgerAfterUSD: (await readBudget()) / 100,
      },
      null,
      2,
    ),
  );
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
}
void main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
