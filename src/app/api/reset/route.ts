import { cookies } from "next/headers";
import {
  COOKIE,
  sessionIdentity,
  okay,
  failure,
  requireOrigin,
} from "@/lib/http";
import { publicSession } from "@/lib/domain";
import { retireConversation } from "@/lib/reset";
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const current = await sessionIdentity();
    await retireConversation(current.id);
    (await cookies()).delete(COOKIE);
    const { session } = await sessionIdentity(true);
    return okay({ session: publicSession(session) });
  } catch (e) {
    return failure(e);
  }
}
