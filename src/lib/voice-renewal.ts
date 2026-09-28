import { endCall, type Session } from "./domain";
import { mutateSession, rawStore, BudgetLimitError } from "./store";
import { createRealtime, hangup } from "./realtime";
import { requestSupervisedStop } from "./voice-stop";
import { VOICE_BUDGET_EVENT, VOICE_RENEWAL_ERROR_EVENT } from "./voice-limits";

export async function waitForVoiceReceipt(
  sessionId: string,
  callId: string,
  timeoutMs = 15000,
) {
  const until = Date.now() + timeoutMs;
  do {
    const receipt = await rawStore.read<{
      sessionId?: string;
      callId: string;
      finalized?: boolean;
      settledCents: number | null;
    }>("voice-usage:" + callId);
    if (receipt?.callId === callId && receipt.sessionId === sessionId) {
      if (
        Number.isSafeInteger(receipt.settledCents) &&
        (receipt.settledCents as number) >= 0
      )
        return;
      if (receipt.finalized)
        throw new Error(
          "The voice connection couldn’t renew because its usage could not be verified. Your conversation is saved.",
        );
    }
    if (Date.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() <= until);
  throw new Error(
    "The voice connection couldn’t renew safely. Your conversation is saved.",
  );
}

type RenewalDependencies = {
  stop: (sessionId: string, callId: string) => Promise<unknown>;
  receipt: (sessionId: string, callId: string) => Promise<unknown>;
  create: (
    s: Session,
    sdp: string,
    continuing: boolean,
  ) => ReturnType<typeof createRealtime>;
  hangup: (callId: string) => Promise<unknown>;
};
const live: RenewalDependencies = {
  stop: (sessionId, callId) =>
    requestSupervisedStop(
      rawStore,
      sessionId,
      callId,
      () => hangup(callId),
      15000,
      250,
      "renewal",
    ),
  receipt: waitForVoiceReceipt,
  create: createRealtime,
  hangup,
};

// Never hold the session lock while waiting for the previous supervisor: its
// final transcripts and verified cost must settle before reserving the next leg.
export async function renewVoiceCall(
  sessionId: string,
  previousCallId: string,
  sdp: string,
  deps: RenewalDependencies = live,
) {
  await mutateSession(sessionId, (s) => {
    if (
      s.retiredAt ||
      s.call.id !== previousCallId ||
      s.call.status !== "active"
    )
      throw new Error("That call is no longer available to renew.");
    s.call.status = "renewing";
  });
  let created: Awaited<ReturnType<typeof createRealtime>> | undefined;
  try {
    await deps.stop(sessionId, previousCallId);
    await deps.receipt(sessionId, previousCallId);
    return await mutateSession(sessionId, async (s) => {
      if (
        s.retiredAt ||
        s.call.id !== previousCallId ||
        s.call.status !== "renewing"
      )
        throw new Error("The call ended before its connection renewed.");
      created = await deps.create(s, sdp, true);
      s.call.previousId = previousCallId;
      s.call.id = created.callId;
      s.call.status = "active";
      return created;
    });
  } catch (e) {
    if (created) await deps.hangup(created.callId).catch(() => {});
    await mutateSession(sessionId, (s) => {
      if (
        !s.retiredAt &&
        s.call.id === previousCallId &&
        s.call.status === "renewing"
      )
        endCall(
          s,
          "failed",
          e instanceof BudgetLimitError
            ? VOICE_BUDGET_EVENT
            : VOICE_RENEWAL_ERROR_EVENT,
        );
    }).catch(() => {});
    throw e;
  }
}
