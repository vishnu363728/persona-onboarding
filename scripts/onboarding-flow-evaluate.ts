/** Eight real text turns through production generateTurn/applyTurn; no voice/OAuth. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  addMessage,
  applyTurn,
  createSession,
  endCall,
  type Session,
} from "../src/lib/domain";
import { generateTurn } from "../src/lib/agent";
import { rawStore } from "../src/lib/store";
import { blobReady } from "../src/lib/blob-store";
import { textConfig } from "../src/lib/text-provider";
import { textReservationCents } from "../src/lib/text-limits";
import { textUsageDollars } from "../src/lib/text-usage";

type Check = { name: string; pass: boolean };
type Dialogue = {
  user: string;
  reply: string;
  action: string;
  source: string;
  usage: unknown;
  checks: Check[];
  state: unknown;
  durationMs: number;
};
async function main() {
  const args = process.argv.slice(2);
  const run = args.includes("--run");
  const label =
    args.find((arg) => arg.startsWith("--label="))?.slice(8) || "onboarding";
  assert.match(label, /^[a-z0-9][a-z0-9-]{0,39}$/);
  for (const arg of args)
    assert.match(arg, /^(--run|--describe|--label=[a-z0-9][a-z0-9-]{0,39})$/);
  const mainTurns = [
    "Call yourself Appy.",
    "My name is Mara.",
    "Wait, how does this work?",
    "I need to practice answering one interview question about resolving a disagreement at work.",
    "That helps. Anything else to set up?",
    "No Gmail, thanks. Let's keep practicing.",
    "Actually, call me Riley. Make the question about disagreeing with my manager, not a teammate.",
  ];
  const skipTurn =
    "Skip setup and just help me draft one sentence asking my manager for feedback after a disagreement.";
  if (!run) {
    console.log(
      JSON.stringify(
        {
          mode: "description-only",
          calls: 0,
          maxTextTurns: 8,
          mainTurns,
          simulatedTransition:
            "Decline the first incoming call after naming, using real endCall; no voice provider connection",
          skipTurn,
          budget:
            "Existing production ledger; preserve51c for voice; stop before another turn after10c accumulated spend/holds; no retries or ledger resets",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const config = textConfig();
  assert.ok(
    config.together && config.model === "zai-org/GLM-5.3-Flash",
    "Use the configured inexpensive Together model, not a higher-cost fallback",
  );
  assert.ok(config.key, "Together API credential must be configured");
  assert.ok(
    blobReady(),
    "Shared production ledger must be configured; never use a fresh local ledger",
  );
  assert.ok(
    Number(process.env.DEMO_BUDGET_USD || 5) <= 10,
    "The explicitly raised shared user cap must remain at most$10",
  );
  const runId = `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const out = `output/qa/onboarding-flow/${runId}`;
  await mkdir("output/qa/onboarding-flow", { recursive: true });
  await mkdir(out);
  const budget = async () => {
    const value = await rawStore.read<{
      cents: number;
      reservations?: Record<string, number>;
    }>("budget");
    assert.ok(
      value && Number.isFinite(value.cents),
      "Existing ledger required",
    );
    return {
      cents: value.cents,
      reservationCount: Object.keys(value.reservations || {}).length,
    };
  };
  const initialBudget = await budget();
  const main = createSession("onboarding-eval-main-" + runId);
  const skip = createSession("onboarding-eval-skip-" + runId);
  const dialogue: Dialogue[] = [],
    skipDialogue: Dialogue[] = [];
  let attempted = 0,
    modelTurns = 0,
    reportedCostCents = 0;
  let simulatedCall:
    { from: string; to: string; attempted: boolean } | undefined;
  let failure: string | undefined;
  const snapshot = (s: Session) => ({
    profile: structuredClone(s.profile),
    call: structuredClone(s.call),
    gmail: { status: s.gmail.status },
    helping: s.helping,
  });
  const checks = (values: Record<string, boolean>): Check[] =>
    Object.entries(values).map(([name, pass]) => ({ name, pass }));
  const notMenu = (reply: string) =>
    !/(?:write|plan|brainstorm).{0,100}(?:research|organize|summarize)/i.test(
      reply,
    );
  async function turn(
    s: Session,
    text: string,
    evaluate: (
      s: Session,
      reply: string,
      action: string,
    ) => Record<string, boolean>,
  ) {
    assert.ok(attempted < 8, "Eight-turn cap reached");
    const before = await budget();
    assert.ok(
      before.cents - initialBudget.cents < 10,
      "Stop after10c cumulative charged usage or new hold; no further paid turn",
    );
    const id = randomUUID();
    addMessage(s, { id, role: "user", text, channel: "text", at: Date.now() });
    assert.ok(
      before.cents + textReservationCents(s) <=
        Math.min(
          initialBudget.cents + 10,
          Number(process.env.DEMO_BUDGET_USD || 5) * 100 - 51,
        ),
      "Preserve51c for the user's next voice attempt, including this turn's reservation",
    );
    const started = Date.now();
    attempted++;
    const result = await generateTurn(s);
    if (result.source === "model") modelTurns++;
    const cost = textUsageDollars(result.usage, config.model, "together");
    if (cost !== undefined) reportedCostCents += cost * 100;
    applyTurn(s, result.turn, id);
    const entry: Dialogue = {
      user: text,
      reply: result.turn.reply,
      action: result.turn.action,
      source: result.source,
      usage: result.usage,
      checks: checks(evaluate(s, result.turn.reply, result.turn.action)),
      state: snapshot(s),
      durationMs: Date.now() - started,
    };
    console.log(
      JSON.stringify({
        turn: attempted,
        pass: entry.checks.every((check) => check.pass),
        failedChecks: entry.checks
          .filter((check) => !check.pass)
          .map((check) => check.name),
        reply: entry.reply,
      }),
    );
    return entry;
  }
  try {
    dialogue.push(
      await turn(main, mainTurns[0], (s, reply, action) => ({
        agentNamed: s.profile.agentName.value === "Appy",
        callAttempted:
          s.call.attempts === 1 &&
          s.call.status === "ringing" &&
          action === "offer_call",
        truthfulCallHandoff: /call|ring/i.test(reply),
        noGenericMenu: notMenu(reply),
      })),
    );
    simulatedCall = {
      from: main.call.status,
      to: "declined",
      attempted: main.call.status === "ringing",
    };
    if (main.call.status === "ringing") endCall(main, "declined");
    dialogue.push(
      await turn(main, mainTurns[1], (s, reply, action) => ({
        userNamed: s.profile.userName.value === "Mara",
        agentKept: s.profile.agentName.value === "Appy",
        noRepeatedCall: s.call.attempts === 1 && action !== "offer_call",
        invitesMissingGoal:
          /\?/.test(reply) &&
          /help|hand|working|work on|tackle|mind|need|easier|use|start/i.test(
            reply,
          ),
        noGenericMenu: notMenu(reply),
      })),
    );
    dialogue.push(
      await turn(main, mainTurns[2], (s, reply, action) => ({
        namesKept:
          s.profile.agentName.value === "Appy" &&
          s.profile.userName.value === "Mara",
        doesNotInventGoal: s.profile.goal.value === null,
        stillGuidesNextStep: /\?/.test(reply),
        explainsBriefly: reply.split(/\s+/).length <= 100,
        noGenericMenu: notMenu(reply),
        noRepeatedCall: action !== "offer_call",
      })),
    );
    dialogue.push(
      await turn(main, mainTurns[3], (s, reply, action) => ({
        goalSaved: /disagree|conflict/i.test(s.profile.goal.value || ""),
        substantiveHelp:
          s.helping && /\?|tell me about|walk me through|describe/i.test(reply),
        topicCarried: /disagree|conflict|resolv/i.test(reply),
        noNameReset: !/what(?:'s| is) your name|what should I call you/i.test(
          reply,
        ),
        noRepeatedCall: action !== "offer_call",
      })),
    );
    dialogue.push(
      await turn(main, mainTurns[4], (s, reply, action) => ({
        gmailAttempted:
          action === "offer_gmail" && s.gmail.status === "offered",
        realConnectionInvitation: /Gmail/i.test(reply),
        noFalseConnection:
          !/(?:Gmail|account) is (?:now )?connected|inbox is connected/i.test(
            reply,
          ),
        sameIdentity: s.profile.userName.value === "Mara",
      })),
    );
    dialogue.push(
      await turn(main, mainTurns[5], (s, reply, action) => ({
        gmailDeclined: s.gmail.status === "declined",
        noRepitch: action !== "offer_gmail",
        resumesUsefulTopic:
          /disagree|conflict|interview|situation|tell me|question/i.test(reply),
        goalKept: /disagree|conflict/i.test(s.profile.goal.value || ""),
        noRepeatedCall: action !== "offer_call",
      })),
    );
    dialogue.push(
      await turn(main, mainTurns[6], (s, reply, action) => ({
        correctionSaved: s.profile.userName.value === "Riley",
        agentKept: s.profile.agentName.value === "Appy",
        gmailRefusalKept: s.gmail.status === "declined",
        noSetupReopened: action === "none",
        revisedQuestion:
          /manager/i.test(reply) && /\?|tell me|describe|walk me/i.test(reply),
        goalKept: /disagree|conflict/i.test(s.profile.goal.value || ""),
        noBookkeeping: !/(?:saved|updated).{0,25}(?:name|memory|profile)/i.test(
          reply,
        ),
      })),
    );
    skipDialogue.push(
      await turn(skip, skipTurn, (s, reply, action) => ({
        noCall: s.call.attempts === 0,
        callSkipped: ["deferred", "declined"].includes(s.call.preference || ""),
        gmailSkipped: ["deferred", "declined"].includes(s.gmail.status),
        namesSkipped: [s.profile.agentName, s.profile.userName].every(
          (field) =>
            !field.value && ["deferred", "declined"].includes(field.status),
        ),
        usefulDraft: s.helping && /feedback/i.test(reply),
        noSetupPrompt:
          action === "none" &&
          !/what.*name|connect.*gmail|quick call/i.test(reply),
      })),
    );
  } catch (error) {
    failure =
      error instanceof Error
        ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        : String(error);
    console.error(failure);
  }
  const finalBudget = await budget();
  const pass =
    !failure &&
    attempted === 8 &&
    modelTurns > 0 &&
    [...dialogue, ...skipDialogue].every((entry) =>
      entry.checks.every((check) => check.pass),
    );
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runId,
        model: config.model,
        pass,
        attempted,
        modelTurns,
        paidVoiceCalls: 0,
        googleConsentAttempted: false,
        reportedCostCents,
        initialBudget,
        finalBudget,
        budgetDeltaCents: finalBudget.cents - initialBudget.cents,
        simulatedCall,
        note: "Call decline is an explicit local domain transition; no real voice/OAuth or fabricated connected status. Dialogue uses actual configured Together generateTurn and real applyTurn. Full replies retained for human quality review; checks combine saved state, actions, and wording.",
        dialogue,
        skipDialogue,
        finalMainState: snapshot(main),
        finalSkipState: snapshot(skip),
        failure,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(`Report: ${out}/report.json`);
  if (!pass) process.exitCode = 1;
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
