import type { Session } from "./domain";

export type OnboardingStep = "agent_name" | "call" | "user_name" | "goal" | "gmail" | "help";

// Keep a direction without making any field a gate to useful conversation.
// Only unknown fields are candidates: a refusal or deferral counts as handled.
export function onboardingFocus(
  s: Session,
  channel: "text" | "voice",
  voiceReady = true,
): { step: OnboardingStep } {
  if (channel === "text" && s.profile.agentName.status === "unknown")
    return { step: "agent_name" };
  if (
    channel === "text" && voiceReady &&
    s.profile.agentName.status === "known" &&
    s.call.attempts === 0 && s.call.status === "never" &&
    (!s.call.preference || s.call.preference === "open")
  ) return { step: "call" };
  if (s.profile.userName.status === "unknown") return { step: "user_name" };
  if (s.profile.goal.status === "unknown") return { step: "goal" };
  if (s.gmail.status === "unknown") return { step: "gmail" };
  return { step: "help" };
}
