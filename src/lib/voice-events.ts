import { addMessage, applyMemory, memorySchema, type Session } from "./domain";
import { shortenMessage, MESSAGE_CHARACTER_LIMIT } from "./history";
import {
  VOICE_USAGE_LIMIT_USD,
  VOICE_BUDGET_EVENT,
  VOICE_ACCOUNTING_ERROR_EVENT,
} from "./voice-limits";
export type VoiceEvent = {
  type: string;
  item_id?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response_id?: string;
  usage?: {
    type?: string;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    input_token_details?: { text_tokens?: number; audio_tokens?: number };
  };
  response?: {
    id?: string;
    status?: string;
    usage?: {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: {
        text_tokens?: number;
        audio_tokens?: number;
        image_tokens?: number;
        cached_tokens?: number;
        cached_tokens_details?: {
          text_tokens?: number;
          audio_tokens?: number;
          image_tokens?: number;
        };
      };
      output_token_details?: {
        text_tokens?: number;
        audio_tokens?: number;
        reasoning_tokens?: number;
      };
    };
  };
};
type Sink = {
  save: (fn: (s: Session) => void) => Promise<unknown>;
  send: (e: unknown) => void;
  stop: (reason: string) => Promise<void>;
  schedule: (work: () => Promise<void>, delayMs: number) => () => void;
  cost?: () => number;
  limitUsd?: number;
  gmailAvailable?: boolean;
};
// This runs on the server's authenticated sideband, never on client-supplied events.
export function voiceEventHandler(sink: Sink) {
  const interrupted = new Set<string>(),
    handledTools = new Set<string>(),
    handledResponses = new Set<string>();
  const pendingTools = new Map<string, VoiceEvent[]>();
  const playingResponses = new Set<string>();
  let reportedCost = 0,
    stopped = false;
  let endingResponse: string | undefined;
  let cancelEndTimer: (() => void) | undefined;
  const stop = async (reason: string) => {
    if (stopped) return;
    stopped = true;
    cancelEndTimer?.();
    await sink.stop(reason);
  };
  const finishSpokenHangup = () => stop("Call ended · continuing in messages");
  const handle = async (e: VoiceEvent) => {
    if (e.type === "output_audio_buffer.started") {
      if (!stopped) playingResponses.add(e.response_id || "");
      return;
    }
    if (
      ["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(
        e.type,
      )
    ) {
      const responseId = e.response_id || "";
      playingResponses.delete(responseId);
      if (endingResponse !== undefined && responseId === endingResponse)
        await finishSpokenHangup();
      return;
    }
    // Transcription may finish after hangup has begun; retain the user's final
    // words, but never start another model response once termination is chosen.
    if (
      (stopped || endingResponse !== undefined) &&
      ![
        "conversation.item.input_audio_transcription.completed",
        "response.output_audio_transcript.done",
        "conversation.item.truncated",
      ].includes(e.type)
    )
      return;
    if (e.type === "response.done") {
      // Realtime can replay a completed response when playback is interrupted.
      if (e.response?.id && handledResponses.has(e.response.id)) return;
      if (e.response?.id) handledResponses.add(e.response.id);
      const u = e.response?.usage;
      if (u) {
        const input = u.input_token_details || {},
          output = u.output_token_details || {};
        reportedCost +=
          ((input.text_tokens || 0) * 4 +
            (input.audio_tokens || 0) * 32 +
            (output.text_tokens || 0) * 24 +
            (output.audio_tokens || 0) * 64) /
          1000000;
      }
      // The authenticated ledger includes cache discounts and transcription.
      // Its unknown-usage sentinel remains a stop condition; never fall back
      // to an uncached estimate just because a known call costs zero so far.
      const guardedCost = sink.cost ? sink.cost() : reportedCost;
      if (
        !Number.isFinite(guardedCost) ||
        guardedCost >= (sink.limitUsd ?? VOICE_USAGE_LIMIT_USD)
      ) {
        await stop(
          Number.isFinite(guardedCost)
            ? VOICE_BUDGET_EVENT
            : VOICE_ACCOUNTING_ERROR_EVENT,
        );
        return;
      }
      const tools = pendingTools.get(e.response?.id || "") || [];
      pendingTools.delete(e.response?.id || "");
      let endRequested = false;
      let memoryFailed = false;
      type Outcome = {
        success: boolean;
        reason: string;
        gmailStatus?: Session["gmail"]["status"];
        cardAvailable?: boolean;
        connectionAvailable?: boolean;
        nextStep?: string;
      };
      const outcomes = new Map<VoiceEvent, Outcome>();
      const emptyArguments = (tool: VoiceEvent) => {
        const args = JSON.parse(tool.arguments || "{}");
        return (
          args !== null &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          Object.keys(args).length === 0
        );
      };
      // Parallel tool generation does not guarantee argument-event order. Save
      // all preferences first so a same-turn refusal/reopening controls the
      // actual card, whichever order offer_gmail and remember arrived in.
      for (const tool of [
        ...tools.filter((tool) => tool.name === "remember"),
        ...tools.filter((tool) => tool.name !== "remember"),
      ]) {
        let outcome: Outcome = {
          success: false,
          reason: "response_not_completed",
        };
        try {
          if (e.response?.status !== "completed") {
            outcomes.set(tool, outcome);
            continue;
          }
          outcome.reason = "invalid_arguments";
          if (tool.name === "remember") {
            const patch = memorySchema.parse(
              JSON.parse(tool.arguments || "{}"),
            );
            outcome.reason = "not_saved";
            await sink.save((s) => {
              applyMemory(s, patch);
              outcome = { success: true, reason: "saved" };
            });
          } else if (tool.name === "offer_gmail" && emptyArguments(tool)) {
            if (memoryFailed) {
              outcomes.set(tool, {
                success: false,
                reason: "memory_not_saved",
                cardAvailable: false,
                connectionAvailable: sink.gmailAvailable ?? false,
                nextStep:
                  "Continue the conversation without another Gmail pitch.",
              });
              continue;
            }
            outcome = {
              success: false,
              reason: "not_saved",
              cardAvailable: false,
              connectionAvailable: sink.gmailAvailable ?? false,
            };
            await sink.save((s) => {
              const previous = s.gmail.status;
              if (!["connected", "declined", "deferred"].includes(previous))
                s.gmail.status = "offered";
              const cardAvailable = s.gmail.status === "offered";
              const connectionAvailable = sink.gmailAvailable ?? false;
              outcome = {
                success: cardAvailable,
                reason: !cardAvailable
                  ? previous === "connected"
                    ? "already_connected"
                    : previous
                  : !connectionAvailable
                    ? "service_unavailable"
                    : previous === "offered"
                      ? "already_offered"
                      : "offered",
                gmailStatus: s.gmail.status,
                cardAvailable,
                connectionAvailable,
                nextStep:
                  cardAvailable && connectionAvailable
                    ? "Tap View Gmail connection, then Connect Gmail; we can keep talking."
                    : "Continue the conversation without another Gmail pitch.",
              };
            });
          } else if (tool.name === "end_call" && emptyArguments(tool)) {
            outcome = { success: true, reason: "ending_call" };
            endRequested = true;
          } else if (
            !["remember", "offer_gmail", "end_call"].includes(tool.name || "")
          ) {
            outcome.reason = "unknown_tool";
          }
        } catch {
          // A save callback may have run before its storage write failed. Do
          // not acknowledge the in-memory mutation as persisted or visible.
          outcome = {
            success: false,
            reason:
              outcome.reason === "invalid_arguments"
                ? "invalid_arguments"
                : "not_saved",
          };
        }
        if (tool.name === "remember" && !outcome.success) memoryFailed = true;
        outcomes.set(tool, outcome);
      }
      for (const tool of tools) {
        sink.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: tool.call_id,
            output: JSON.stringify(outcomes.get(tool)),
          },
        });
      }
      if (endRequested) {
        endingResponse = e.response?.id || "";
        // response.done means generation finished, not that the user has heard
        // the buffered acknowledgment. Wait for its WebRTC playback to drain,
        // while bounding the wait if that event never arrives.
        if (playingResponses.has(endingResponse))
          cancelEndTimer = sink.schedule(finishSpokenHangup, 3000);
        else await finishSpokenHangup();
      } else if (tools.length && e.response?.status === "completed") {
        // Cancelled/incomplete tool arguments also produce .done events. Do not
        // save them or race the user's new VAD response with a continuation.
        sink.send({ type: "response.create" });
      }
    }
    if (
      e.type === "conversation.item.input_audio_transcription.completed" &&
      e.item_id &&
      e.transcript?.trim()
    ) {
      await sink.save((s) =>
        addMessage(s, {
          id: e.item_id!,
          role: "user",
          text: shortenMessage(e.transcript!.trim(), MESSAGE_CHARACTER_LIMIT),
          channel: "voice",
          at: Date.now(),
        }),
      );
    }
    if (
      e.type === "response.output_audio_transcript.done" &&
      e.item_id &&
      e.transcript?.trim()
    ) {
      await sink.save((s) =>
        addMessage(s, {
          id: e.item_id!,
          role: "assistant",
          text: interrupted.has(e.item_id!)
            ? "[Assistant speech interrupted]"
            : shortenMessage(e.transcript!.trim(), MESSAGE_CHARACTER_LIMIT),
          interrupted: interrupted.has(e.item_id!),
          channel: "voice",
          at: Date.now(),
        }),
      );
    }
    if (e.type === "conversation.item.truncated" && e.item_id) {
      interrupted.add(e.item_id);
      await sink.save((s) => {
        const m = s.messages.find((m) => m.id === e.item_id);
        if (m) {
          m.interrupted = true;
          m.text = "[Assistant speech interrupted]";
        }
      });
    }
    if (
      e.type === "response.function_call_arguments.done" &&
      e.call_id &&
      !handledTools.has(e.call_id)
    ) {
      handledTools.add(e.call_id);
      if (e.response_id && handledResponses.has(e.response_id)) return;
      const key = e.response_id || "";
      pendingTools.set(key, [...(pendingTools.get(key) || []), e]);
    }
  };
  return Object.assign(handle, {
    dispose() {
      cancelEndTimer?.();
      stopped = true;
    },
  });
}
