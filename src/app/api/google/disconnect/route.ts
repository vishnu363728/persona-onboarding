import { sessionIdentity, requireOrigin, okay, failure } from "@/lib/http";
import { decryptTokens, revokeToken } from "@/lib/google";
import { addMessage, publicSession } from "@/lib/domain";
import { mutateSession } from "@/lib/store";
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const { id } = await sessionIdentity();
    const { session } = await mutateSession(id, async (s) => {
      if (s.gmail.status !== "connected" && !s.gmail.encryptedTokens) return;
      if (s.gmail.encryptedTokens) {
        const tokens = decryptTokens(s.gmail.encryptedTokens);
        await revokeToken(tokens.refresh_token || tokens.access_token);
      }
      s.gmail = { status: "deferred" };
      addMessage(s, {
        id: "gmail-disconnected:" + Date.now(),
        role: "event",
        channel: "system",
        text: "Gmail disconnected",
        at: Date.now(),
      });
    });
    return okay({ session: publicSession(session) });
  } catch (e) {
    return failure(e);
  }
}
