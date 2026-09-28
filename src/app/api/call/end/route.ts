import { z } from "zod";
import {
  sessionIdentity,
  okay,
  failure,
  requireOrigin,
  jsonBody,
} from "@/lib/http";
import { publicSession, endCall } from "@/lib/domain";
import { mutateSession, getSession, rawStore } from "@/lib/store";
import { hangup } from "@/lib/realtime";
import {
  requestSupervisedStop,
  waitForVoiceSettlement,
} from "@/lib/voice-stop";
export const maxDuration = 60;
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const body = z
      .object({ callId: z.string().max(100).optional() })
      .parse(await jsonBody(req));
    const { id } = await sessionIdentity();
    const { session, result } = await mutateSession(id, (s) => {
      // Resolve the ID inside the lock: cancellation may race the SDP handshake.
      if (
        body.callId &&
        s.call.id !== body.callId &&
        s.call.previousId !== body.callId
      )
        return;
      const activeId = ["active", "connecting", "renewing"].includes(
        s.call.status,
      )
        ? s.call.id
        : undefined;
      if (
        ["active", "connecting", "renewing", "ringing", "never"].includes(
          s.call.status,
        )
      ) {
        s.call.attempts = Math.max(1, s.call.attempts);
        endCall(
          s,
          "ended",
          s.call.id
            ? "Audio call ended"
            : "Call cancelled · staying in messages",
        );
      }
      return { activeId, settlementId: s.call.id };
    });
    // Do not wait inside the session lock: the supervisor also persists final
    // transcripts there. It must initiate hangup before losing its sideband.
    let acknowledged = !result?.activeId;
    if (result?.activeId)
      acknowledged = await requestSupervisedStop(
        rawStore,
        id,
        result.activeId,
        () => hangup(result.activeId!).catch(() => false),
        10000,
      );
    // The provider ACK does not mean final transcripts or the budget receipt
    // have persisted yet. Keep the handoff outside the session lock so the
    // supervisor can finish before text tries to reserve its own usage.
    if (result?.settlementId)
      await waitForVoiceSettlement(
        rawStore,
        id,
        result.settlementId,
        acknowledged ? 10000 : 0,
      );
    return okay({ session: publicSession((await getSession(id)) || session) });
  } catch (e) {
    return failure(e);
  }
}
