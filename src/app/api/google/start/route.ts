import { sessionIdentity } from "@/lib/http";
import { gmailReady } from "@/lib/agent";
import { throttle } from "@/lib/store";
import { appOrigin, prepareGoogleAuthorization } from "@/lib/google";
import { googleCompletionResponse } from "@/lib/google-completion";
export async function GET(req: Request) {
  const origin = appOrigin(req);
  const popup = new URL(req.url).searchParams.get("popup") === "1";
  try {
    if (!gmailReady())
      return googleCompletionResponse(origin, "unavailable", popup);
    const { id } = await sessionIdentity();
    await throttle(id + ":oauth", 5, 600000);
    return Response.redirect(
      await prepareGoogleAuthorization(id, origin, { popup }),
      303,
    );
  } catch {
    return googleCompletionResponse(origin, "error", popup);
  }
}
