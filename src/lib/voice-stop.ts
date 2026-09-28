// A cross-instance request, not billing proof. Only the live sideband supervisor
// can turn it into local pre-close termination evidence. No client timestamps.
export type VoiceStopRequest = {
  sessionId: string;
  callId: string;
  status: "requested" | "ended" | "failed";
  kind?: "renewal";
};
type Store = {
  read: <T>(key: string) => Promise<T | null>;
  write: (key: string, value: unknown) => Promise<unknown>;
};
const key = (callId: string) => "voice-stop:" + callId;
const matches = (
  request: VoiceStopRequest | null,
  sessionId: string,
  callId: string,
) => request?.sessionId === sessionId && request.callId === callId;

export async function waitForVoiceSettlement(
  store: Pick<Store, "read">,
  sessionId: string,
  callId: string,
  timeoutMs = 5000,
  pollMs = 100,
): Promise<"settled" | "unverified" | "pending"> {
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const checking = (async () => {
    while (!finished) {
      const receipt = await store.read<{
        sessionId?: string;
        callId: string;
        finalized?: boolean;
        settledCents: number | null;
      }>("voice-usage:" + callId);
      if (finished) break;
      if (receipt?.sessionId === sessionId && receipt.callId === callId) {
        if (
          Number.isSafeInteger(receipt.settledCents) &&
          (receipt.settledCents as number) >= 0
        )
          return "settled" as const;
        if (receipt.finalized) return "unverified" as const;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return "pending" as const;
  })().catch(() => "pending" as const);
  try {
    return await Promise.race([
      checking,
      new Promise<"pending">((resolve) => {
        timeout = setTimeout(() => resolve("pending"), timeoutMs);
      }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timeout);
  }
}

export async function pollVoiceStop(
  store: Store,
  sessionId: string,
  callId: string,
  canStop: (request: VoiceStopRequest) => boolean,
  stop: () => Promise<boolean>,
) {
  const request = await store.read<VoiceStopRequest>(key(callId));
  // Recheck after storage I/O: a request read after transport loss must never
  // reclassify that loss as a controlled hangup.
  if (
    !matches(request, sessionId, callId) ||
    request!.status !== "requested" ||
    !canStop(request!)
  )
    return false;
  const acknowledged = await stop();
  await store.write(key(callId), {
    sessionId,
    callId,
    status: acknowledged ? "ended" : "failed",
  } satisfies VoiceStopRequest);
  return true;
}

export async function requestSupervisedStop(
  store: Store,
  sessionId: string,
  callId: string,
  fallback: () => Promise<unknown>,
  timeoutMs = 3000,
  pollMs = 250,
  kind?: "renewal",
) {
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async () => {
    await store.write(key(callId), {
      sessionId,
      callId,
      status: "requested",
      ...(kind ? { kind } : {}),
    } satisfies VoiceStopRequest);
    while (!finished) {
      const result = await store.read<VoiceStopRequest>(key(callId));
      if (finished) return false;
      if (matches(result, sessionId, callId) && result!.status !== "requested")
        return result!.status === "ended";
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
  })().catch(() => false);
  const acknowledged = await Promise.race([
    request,
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  finished = true;
  clearTimeout(timeout);
  // No supervisor / lost storage / no successful provider acknowledgment:
  // still stop the provider, but never upgrade the accounting evidence.
  if (!acknowledged) await fallback();
  return acknowledged;
}
