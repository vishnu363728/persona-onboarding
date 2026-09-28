import {
  sessionIdentity,
  okay,
  failure,
  requireOrigin,
  jsonBody,
} from "@/lib/http";
import { publicSession } from "@/lib/domain";
import { chatSchema, processChat, ChatConflictError } from "@/lib/chat";
export const maxDuration = 60;
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const body = chatSchema.parse(await jsonBody(req));
    const { id } = await sessionIdentity();
    const result = await processChat(id, body);
    return okay({ session: publicSession(result) });
  } catch (e) {
    if (e instanceof ChatConflictError)
      return Response.json(
        { error: e.message, retryable: false },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    return failure(e);
  }
}
