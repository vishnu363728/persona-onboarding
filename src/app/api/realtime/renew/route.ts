import { after } from "next/server";
import { z } from "zod";
import {
  sessionIdentity,
  okay,
  failure,
  requireOrigin,
  jsonBody,
} from "@/lib/http";
import { publicSession, endCall } from "@/lib/domain";
import { mutateSession, BudgetLimitError } from "@/lib/store";
import { superviseCall, hangup } from "@/lib/realtime";
import { renewVoiceCall } from "@/lib/voice-renewal";
import {
  voiceRenewAfterSeconds,
  VOICE_RENEWAL_ERROR_EVENT,
  VOICE_SUPERVISION_TIMEOUT_SECONDS,
} from "@/lib/voice-limits";
export const runtime = "nodejs";
export const maxDuration = 800;
const schema = z.object({
  callId: z.string().min(1).max(100),
  sdp: z.string().min(20).max(50000),
});
export async function POST(req: Request) {
  const supervisionDeadline =
    Date.now() + VOICE_SUPERVISION_TIMEOUT_SECONDS * 1000;
  let sessionId: string | undefined;
  let callId: string | undefined;
  let supervisor: ReturnType<typeof superviseCall> | undefined;
  try {
    requireOrigin(req);
    const body = schema.parse(await jsonBody(req));
    const { id } = await sessionIdentity();
    sessionId = id;
    const { session, result } = await renewVoiceCall(id, body.callId, body.sdp);
    callId = result.callId;
    supervisor = superviseCall(id, result.callId, {
      ...result,
      supervisionDeadline,
    });
    after(() => supervisor!.done);
    await supervisor.connected;
    return okay({
      sdp: result.sdp,
      contextContract: result.contextContract,
      openingInstruction: "openingInstruction" in result ? result.openingInstruction : undefined,
      callId: result.callId,
      session: publicSession(session),
      renewAfterSeconds: voiceRenewAfterSeconds(supervisionDeadline),
    });
  } catch (e) {
    if (supervisor) await supervisor.abort();
    else if (callId) await hangup(callId).catch(() => {});
    if (sessionId && callId)
      await mutateSession(sessionId, (s) => {
        if (s.call.id === callId)
          endCall(s, "failed", VOICE_RENEWAL_ERROR_EVENT);
      }).catch(() => {});
    if (e instanceof BudgetLimitError)
      return Response.json(
        { error: e.message, code: "budget_exhausted" },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    return failure(e);
  }
}
