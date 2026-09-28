import { type AgentTurn, type Message, type Session } from "./domain";

function normalized(text: string) {
  return text.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
}

function bareAssent(text: string) {
  return /^(?:yes|yeah|yep|yup|sure|okay|ok)[.!?]*$/.test(normalized(text));
}

function standaloneGmailRefusal(text: string) {
  const value = normalized(text).replace(/[.!]+$/, "");
  // Whole-message matches deliberately exclude quotations, examples, and
  // refusal-plus-task messages, which still need the conversational model.
  return /^(?:please )?(?:no (?:gmail|email)(?: for me)?(?:,? please)?|(?:don't|do not|never) (?:connect|link) (?:my )?(?:gmail|email)(?: account)?(?:,? please)?|i (?:don't|do not) want (?:to (?:connect|link) )?(?:my )?(?:gmail|email)(?: account)?|(?:gmail|email) (?:isn't|is not) for me(?:,? (?:let's|let us) leave (?:it|that) out)?|(?:let's|let us) leave (?:gmail|email) out|(?:i'd|i would) rather not (?:connect|link) (?:my )?(?:gmail|email)(?: account)?)$/.test(value);
}

function agentNamingQuestion(message: Message | undefined) {
  if (message?.role !== "assistant" || message.channel !== "text") return false;
  const text = normalized(message.text);
  if (!text.includes("?") || /[`"“”]|\b(?:example|roleplay|quoted?)\b/.test(text))
    return false;
  return (
    /\b(?:got|have) (?:a )?name in mind for me\?/.test(text) ||
    /\bwhat (?:would you like to|do you want to|should you) call me\?/.test(text) ||
    /\b(?:want to|would you like to) (?:give me a name|name me)\?/.test(text) ||
    /\bwhat name (?:would you like (?:to use )?for me|should i (?:use|go by))\?/.test(text)
  );
}

function emptyTurn(reply: string): AgentTurn {
  return {
    reply,
    memory: {
      agentName: null,
      userName: null,
      goal: null,
      callPreference: "unchanged",
      gmailPreference: "unchanged",
      helping: false,
    },
    action: "none",
  };
}

// These exact standalone decisions need no model inference. Never mutate the
// session: the route persists this valid turn through its usual applyTurn path.
export function getConversationGuard(s: Session): AgentTurn | undefined {
  const latest = s.messages.at(-1);
  if (latest?.role !== "user" || latest.channel !== "text") return;

  if (s.gmail.status !== "connected" && standaloneGmailRefusal(latest.text)) {
    const turn = emptyTurn("No problem—we can leave Gmail out.");
    turn.memory.gmailPreference = "declined";
    return turn;
  }

  if (
    s.profile.agentName.status !== "unknown" ||
    s.profile.agentName.value !== null ||
    !bareAssent(latest.text)
  ) return;

  const conversation = s.messages.filter((message) => message.role !== "event");
  const question = conversation.at(-2);
  const previousUser = conversation.at(-3);
  const previousQuestion = conversation.at(-4);
  const repeated =
    previousUser?.role === "user" &&
    previousUser.channel === "text" &&
    bareAssent(previousUser.text) &&
    agentNamingQuestion(previousQuestion);
  const followUp =
    repeated && question?.role === "assistant" && question.channel === "text" &&
    normalized(question.text) === "what name did you have in mind?";
  if (!agentNamingQuestion(question) && !followUp) return;

  if (!repeated) return emptyTurn("What name did you have in mind?");
  const turn = emptyTurn("We can leave the name for later. What could you use a hand with?");
  turn.memory.agentName = { value: null, status: "deferred" };
  if (
    s.call.attempts === 0 && s.call.status === "never" &&
    (s.call.preference || "open") === "open"
  ) turn.memory.callPreference = "deferred";
  return turn;
}
