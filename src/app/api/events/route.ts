import { z } from "zod";
import {
  sessionIdentity,
  okay,
  failure,
  requireOrigin,
  jsonBody,
} from "@/lib/http";
import { publicSession, endCall, markCallUnavailable } from "@/lib/domain";
import { mutateSession } from "@/lib/store";
const schema = z.object({
  event: z.enum([
    "decline",
    "missed",
    "defer_gmail",
    "decline_gmail",
    "show_gmail",
    "call_unavailable",
  ]),
});
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const { event } = schema.parse(await jsonBody(req));
    const { id } = await sessionIdentity();
    const { session } = await mutateSession(id, (s) => {
      if (event === "decline" || event === "missed") {
        if (s.call.status === "ringing")
          endCall(s, event === "decline" ? "declined" : "missed");
      } else if (event === "call_unavailable") {
        markCallUnavailable(s);
      } else if (s.gmail.status !== "connected")
        s.gmail.status =
          event === "defer_gmail"
            ? "deferred"
            : event === "decline_gmail"
              ? "declined"
              : "offered";
    });
    return okay({ session: publicSession(session) });
  } catch (e) {
    return failure(e);
  }
}
