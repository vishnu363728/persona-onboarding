import { endCall } from "./domain";
import { mutateSession, rawStore } from "./store";
import { requestSupervisedStop } from "./voice-stop";
import { hangup } from "./realtime";

// Wait for a concurrent handshake, then retire this identity before rotating its
// cookie. New queued requests cannot start an orphan call in the old session.
// The supervisor may still save final transcripts and settle observed usage.
export async function retireConversation(
  id: string,
  stop = (callId: string) =>
    requestSupervisedStop(rawStore, id, callId, () => hangup(callId)),
) {
  const { result } = await mutateSession(id, (s) => {
    if (s.retiredAt) return;
    s.retiredAt = Date.now();
    const callId =
      s.call.id && ["active", "connecting", "renewing"].includes(s.call.status)
        ? s.call.id
        : undefined;
    if (["active", "connecting", "renewing", "ringing"].includes(s.call.status))
      endCall(s, "ended", "Call ended · new conversation");
    return callId;
  });
  if (result) {
    try {
      await stop(result);
    } catch {
      // Reset must still rotate the retired cookie. Local audio is already
      // stopped; the supervisor retains its independent time/budget guard and
      // uncertain usage hold. Provider cleanup failure cannot strand the UI.
      console.error("Reset call cleanup did not confirm provider shutdown");
    }
  }
}
