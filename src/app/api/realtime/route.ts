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
import { mutateSession, throttle, BudgetLimitError } from "@/lib/store";
import { createRealtime, superviseCall, hangup } from "@/lib/realtime";
import {
  voiceRenewAfterSeconds,
  VOICE_SUPERVISION_TIMEOUT_SECONDS,
} from "@/lib/voice-limits";
export const runtime = "nodejs";
export const maxDuration = 800;
const schema = z.object({
  sdp: z.string().min(20).max(50000),
  direction: z.enum(["incoming", "outgoing"]),
});
export async function POST(req: Request) {
  const supervisionDeadline =
    Date.now() + VOICE_SUPERVISION_TIMEOUT_SECONDS * 1000;
  let callId: string | undefined;
  let sessionId: string | undefined;
  let initiated = false;
  let supervisor: ReturnType<typeof superviseCall> | undefined;
  try {
    requireOrigin(req);
    const body = schema.parse(await jsonBody(req));
    const { id } = await sessionIdentity();
    sessionId = id;
    await throttle(id + ":call", 4, 600000);
    const { session, result } = await mutateSession(id, async (s) => {
      // Reset may retire this session while a call waits for the session lock.
      // Check again here before reserving budget or creating a provider call.
      if (s.retiredAt)
        throw new Error("This conversation was reset. Refresh to start again.");
      if (["active", "connecting", "renewing"].includes(s.call.status))
        throw new Error("A call is already in progress.");
      initiated = true;
      if (body.direction === "outgoing") s.call.attempts++;
      s.call.status = "connecting";
      s.call.direction = body.direction;
      s.call.startedAt = Date.now();
      delete s.call.previousId;
      const result = await createRealtime(s, body.sdp);
      s.call.id = result.callId;
      callId = result.callId;
      s.call.status = "active";
      return result;
    });
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
      renewAfterSeconds: voiceRenewAfterSeconds(supervisionDeadline),
      // Compatibility for cached clients that predate transport renewal.
      limitSeconds: VOICE_SUPERVISION_TIMEOUT_SECONDS,
      session: publicSession(session),
    });
  } catch (e) {
    if (supervisor) await supervisor.abort();
    else if (callId) await hangup(callId).catch(() => {});
    if (sessionId && initiated && callId)
      await mutateSession(sessionId, (s) => {
        if (s.call.id === callId) endCall(s, "failed");
      }).catch(() => {});
    if (e instanceof BudgetLimitError)
      return Response.json(
        { error: e.message, code: "budget_exhausted" },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    return failure(e);
  }
}
