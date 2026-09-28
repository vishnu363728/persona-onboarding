// Legacy/evaluation admission buffer, not a runtime per-call cutoff. Live calls
// reserve the currently available global allowance and deduct shutdown headroom.
export const VOICE_USAGE_LIMIT_CENTS = 75;
export const VOICE_SHUTDOWN_HEADROOM_CENTS = 50;
export const VOICE_RESERVATION_CENTS =
  VOICE_USAGE_LIMIT_CENTS + VOICE_SHUTDOWN_HEADROOM_CENTS;
export const VOICE_USAGE_LIMIT_USD = VOICE_USAGE_LIMIT_CENTS / 100;
export const VOICE_RENEW_AFTER_SECONDS = 660;
// Transport renewal should finish before Vercel's 800s function lifetime. This
// watchdog handles a missing/failed renewal, not a healthy call's duration.
export const VOICE_SUPERVISION_TIMEOUT_SECONDS = 750;
export function voiceRenewAfterSeconds(deadline: number) {
  return Math.max(
    1,
    Math.min(
      VOICE_RENEW_AFTER_SECONDS,
      Math.floor((deadline - Date.now()) / 1000) - 90,
    ),
  );
}
export const VOICE_BUDGET_EVENT = "Call ended · demo token budget";
export const VOICE_ACCOUNTING_ERROR_EVENT =
  "Call ended · usage tracking unavailable";
export const VOICE_RENEWAL_ERROR_EVENT =
  "Call ended · connection renewal failed";
