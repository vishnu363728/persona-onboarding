/** New unseen wording/topics. No model, storage, voice, or Google calls. */
import { type HumanScenario } from "./human-onboarding-scenarios";

export const humanHoldouts: HumanScenario[] = [
  {
    id: "holdout-repeated-yes-tangent-and-known-name",
    purpose:
      "Handle repeated short answers without a naming loop, tolerate a playful tangent, then preserve a volunteered name when the remaining setup is skipped.",
    steps: [
      {
        user: "yes",
        expect: {
          action: "none",
          "profile.agentName.status": "unknown",
          "profile.userName.status": "unknown",
          "call.attempts": 0,
          helping: false,
        },
        review:
          "One light clarification of agent naming; no invented personal facts. The exact question matters for interpreting the next yes.",
      },
      {
        user: "yes",
        expect: {
          action: { oneOf: ["none", "offer_call"] },
          "profile.agentName.status": { oneOf: ["deferred", "known"] },
          "profile.userName.status": "unknown",
          "call.attempts": { oneOf: [0, 1] },
          helping: false,
        },
        review:
          "Resolve rather than ask the same name question a third time. If the prior assistant explicitly asked permission to choose, this yes can authorize one chosen name and eligible call; otherwise leave the ambiguous name for later and move on. Judge this against the actual preceding reply, not just state.",
      },
      {
        user: "🦆 keyboards should have a duck key lol",
        expect: {
          action: "none",
          "profile.userName.status": "unknown",
          "profile.goal.status": "unknown",
        },
        review:
          "A brief natural response to the playful aside. Don't turn it into an intake question, invent a personal fact/task, or start another call.",
      },
      {
        user: "I'm Tess. Could you write my neighbor a quick note asking if they could water my plants while I'm away? No dates yet. No calls.",
        expect: {
          action: "none",
          "profile.userName.value": "Tess",
          "profile.goal.status": "known",
          "call.preference": "declined",
          helping: true,
        },
        review:
          "Deliver a sendable short note with no invented dates or reason. Save Tess and stop any ringing; no request for the neighbor's name before drafting.",
      },
      {
        user: "Skip the rest of the setup. Make that a little more casual.",
        expect: {
          action: "none",
          "profile.userName.value": "Tess",
          "profile.userName.status": "known",
          "profile.goal.status": "known",
          "call.preference": "declined",
          "gmail.status": "deferred",
          helping: true,
        },
        review:
          "Revise directly and preserve Tess: skipping remaining setup is not a request to forget supplied facts. Keep the stronger existing call decline, defer Gmail, and add no new dates or follow-up offer.",
      },
    ],
  },
  {
    id: "holdout-gmail-reopens-without-call",
    purpose:
      "Give value first, respect an email refusal, and reopen only Gmail while calls stay declined.",
    steps: [
      {
        user: "You can be Milo; I'm Dev. Text only please. Write a note asking my flatmate to turn the music down after ten.",
        expect: {
          action: "none",
          "profile.agentName.value": "Milo",
          "profile.userName.value": "Dev",
          "profile.goal.status": "known",
          "call.preference": "declined",
          "call.attempts": 0,
          "gmail.status": "unknown",
          helping: true,
        },
        review:
          "A calm usable note using the actual after-ten constraint. Don't invent sleep problems, a prior argument, or noise violations. No name/call/Gmail intake.",
      },
      {
        user: "Email isn't for me, let's leave that out.",
        expect: {
          action: "none",
          "gmail.status": "declined",
          "call.preference": "declined",
          "call.attempts": 0,
        },
        review:
          "One relaxed acknowledgment. No persuasion, connection pitch, or unnecessary alternative question.",
      },
      {
        user: "On second thought, let's verify my Gmail. Still no calling, though.",
        expect: {
          action: "offer_gmail",
          "gmail.status": "offered",
          "call.preference": "declined",
          "call.attempts": 0,
        },
        review:
          "Offer the real Connect Gmail button in messages, with truthful verification-only wording. Do not mention a voice-only screen control or ring.",
      },
      {
        fixture: "connected-gmail",
        user: "All done. Thanks, I'll take it from here.",
        expect: {
          action: "none",
          "gmail.status": "connected",
          "call.preference": "declined",
          "call.attempts": 0,
        },
        review:
          "Short close. No repeated onboarding confirmation, new question, call offer, or promise of background work.",
      },
    ],
  },
];
