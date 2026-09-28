/** Offline by default. --live uses the existing shared ledger and preserves a voice reservation. */
import { writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { applyTurn } from "../src/lib/domain";
import { textConfig } from "../src/lib/text-provider";
import { textUsageDollars } from "../src/lib/text-usage";
import { textReservationCents } from "../src/lib/text-limits";
import {
  humanScenarios,
  createHumanSession,
  beginHumanStep,
  checkHumanStep,
  humanReviewRubric,
  canStartHumanTurn,
  validateHumanScenarios,
} from "./human-onboarding-scenarios";

import { humanHoldouts } from "./human-onboarding-holdouts";

async function main() {
  const live = process.argv.includes("--live");
  const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8);
  const selection = process.argv
    .find((a) => a.startsWith("--scenarios="))
    ?.slice(12)
    .split(",");
  const corpus = [...humanScenarios, ...humanHoldouts];
  const scenarios = selection
    ? corpus.filter((s) => selection.includes(s.id))
    : corpus;
  if (selection && scenarios.length !== selection.length)
    throw Error("Unknown/duplicate scenario");
  if (!live) {
    console.log(
      JSON.stringify(
        {
          mode: "offline-plan",
          coreValidation: validateHumanScenarios(),
          scenarioCount: scenarios.length,
          turnCount: scenarios.reduce(
            (total, scenario) => total + scenario.steps.length,
            0,
          ),
          selected: scenarios.map((s) => s.id),
          rubric: humanReviewRubric,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!label || !/^[a-z0-9-]{1,50}$/.test(label))
    throw Error("Live runs require a unique --label=lowercase-name");
  const file = path.join("output", "qa", `human-${label}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await access(file);
    throw Error("Refusing to overwrite an existing report");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const { generateTurn } = await import("../src/lib/agent");
  const { rawStore } = await import("../src/lib/store");
  async function ledger() {
    const b = await rawStore.read<{ cents: number }>("budget");
    if (!b || !Number.isFinite(b.cents))
      throw Error("Existing shared ledger required");
    return b.cents;
  }
  const report: any = {
    at: new Date().toISOString(),
    model: textConfig().model,
    provider: textConfig().base,
    guard:
      "Existing $5 ledger; preserve 125 cents for a future voice call, including current text reservation.",
    maxHistoryReservationCents: textReservationCents(),
    beforeCents: await ledger(),
    scope:
      "Provider replies and narrow app consent/ambiguity guards are labeled per turn; call/OAuth events are labeled domain fixtures.",
    rubric: humanReviewRubric,
    scenarios: [],
  };
  for (const scenario of scenarios) {
    const session = createHumanSession(scenario);
    const entry: any = {
      id: scenario.id,
      purpose: scenario.purpose,
      turns: [],
    };
    report.scenarios.push(entry);
    for (const [i, step] of scenario.steps.entries()) {
      const fixture = beginHumanStep(session, step, i);
      const reservationCents = textReservationCents(session);
      if (!canStartHumanTurn(await ledger(), reservationCents))
        throw Error("Stopping to preserve voice headroom");
      const started = performance.now();
      try {
        const result = await generateTurn(session);
        applyTurn(session, result.turn, "reply-" + i);
        const checks = checkHumanStep(session, result.turn, step);
        entry.turns.push({
          user: step.user,
          fixture,
          reservationCents,
          turn: result.turn,
          source: result.source,
          checks,
          review: step.review,
          usage: result.usage,
          costUSD: textUsageDollars(
            result.usage,
            textConfig().model,
            textConfig().together ? "together" : textConfig().directOpenAI,
          ),
          ms: Math.round(performance.now() - started),
          state: structuredClone({
            profile: session.profile,
            gmail: session.gmail,
            call: session.call,
            helping: session.helping,
          }),
        });
        console.log(
          JSON.stringify({
            scenario: scenario.id,
            turn: i + 1,
            failed: Object.keys(checks).filter((k) => !checks[k]),
            ms: entry.turns.at(-1).ms,
            reply: result.turn.reply,
          }),
        );
      } catch (e) {
        entry.error = String(e);
        console.log(
          JSON.stringify({ scenario: scenario.id, error: entry.error }),
        );
        break;
      } finally {
        report.afterCents = await ledger();
        await writeFile(file, JSON.stringify(report, null, 2));
      }
    }
  }
  console.log(
    JSON.stringify({
      report: file,
      observedTextUSD: report.scenarios
        .flatMap((s: any) => s.turns)
        .reduce((sum: number, turn: any) => sum + (turn.costUSD ?? 0), 0),
      // A shared ledger delta can include concurrent tests or user activity.
      sharedLedgerDeltaUSD: (report.afterCents - report.beforeCents) / 100,
    }),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
