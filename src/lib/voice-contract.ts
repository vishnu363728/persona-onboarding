type VoiceConfiguration = {
  model?: string;
  instructions?: string | null;
  input?: { role?: string; content?: { text?: string; type?: string }[] }[];
  delegation?: { type?: string; responses?: unknown } | null;
  tools?: { name?: string }[];
  audio?: {
    output?: { voice?: string | { id: string } };
    input?: {
      transcription?: { model?: string };
      turn_detection?: { type?: string };
    };
  };
  output_modalities?: string[];
  max_output_tokens?: number | string;
};

// Live may add IDs/status to history and normalize assistant text types. Compare
// the ordered roles and text the model receives, rather than those metadata.
export function voiceContextContract(session: VoiceConfiguration) {
  if (session.model === "gpt-live-1") {
    return JSON.stringify([
      "live",
      session.model,
      session.instructions ?? "",
      session.input?.map((item) => [
        item.role,
        item.content?.map((part) => part.text),
      ]) ?? [],
      session.delegation?.type ?? "client",
      session.delegation?.responses ?? null,
      session.audio?.output?.voice ?? "marin",
    ]);
  }
  return JSON.stringify([
    session.model,
    session.instructions,
    session.tools?.map((tool) => tool.name).sort(),
    session.audio?.output?.voice,
    session.audio?.input?.transcription?.model,
    session.audio?.input?.turn_detection?.type,
    session.output_modalities,
    session.max_output_tokens,
  ]);
}

export function isLiveContract(contract?: string): boolean {
  if (!contract) return false;
  try {
    const value = JSON.parse(contract);
    return (
      Array.isArray(value) && value[0] === "live" && value[1] === "gpt-live-1"
    );
  } catch {
    return false;
  }
}

export const LIVE_OPENING_INSTRUCTION =
  "Begin speaking now in English using the call-opening instructions and saved conversation in this session. Use your chosen name and the next onboarding step already specified; do not restart or ask for facts already known. Then pause and listen.";

export const LIVE_OPENING_RETRY_DELAY_MS = 6000;
export const LIVE_OPENING_RETRY_TIMEOUT_MS = 8000;
export function liveOpeningRetryInstruction(openingInstruction?: string) {
  const quoted = openingInstruction?.match(
    /Say this opening now:\s*("(?:[^"\\]|\\.)*")/,
  );
  let phrase = "Hey, I’m here.";
  try {
    if (quoted) phrase = JSON.parse(quoted[1]);
  } catch {
    /* Use the brief fallback. */
  }
  return `Speak now in English. Say exactly ${JSON.stringify(phrase)}, then stop speaking and listen.`;
}
