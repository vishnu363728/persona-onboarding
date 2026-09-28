import { sessionIdentity } from "@/lib/http";
import {
  appOrigin,
  completeGoogleAuthorization,
  googleAuthorizationPopup,
} from "@/lib/google";
import { googleCompletionResponse } from "@/lib/google-completion";
export async function GET(req: Request) {
  const origin = appOrigin(req);
  let popup: boolean | undefined;
  try {
    const { id } = await sessionIdentity();
    const url = new URL(req.url);
    popup = await googleAuthorizationPopup(id, url);
    const result = await completeGoogleAuthorization(id, url);
    return googleCompletionResponse(origin, result, popup === true);
  } catch (e) {
    console.error(
      "Gmail authorization",
      e instanceof Error ? e.message : "failed",
    );
    // Without a valid identity/attempt, prefer a static failure page over
    // creating a new conversation in a popup. No provider error is displayed.
    return googleCompletionResponse(origin, "error", popup !== false);
  }
}
