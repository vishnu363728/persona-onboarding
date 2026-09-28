import { sessionIdentity, okay, failure } from "@/lib/http";
import { publicSession } from "@/lib/domain";
import { gmailReady, textReady } from "@/lib/agent";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const { session } = await sessionIdentity(true);
    return okay({
      session: publicSession(session),
      capabilities: {
        text: textReady(),
        voice: !!process.env.OPENAI_API_KEY,
        gmail: gmailReady(),
      },
    });
  } catch (e) {
    return failure(e, 503);
  }
}
