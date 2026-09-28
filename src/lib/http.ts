import { ZodError } from "zod";
import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { getSession, newSession } from "./store";
import type { Session } from "./domain";
export const COOKIE = "persona_session";
export async function sessionIdentity(
  create = false,
): Promise<{ id: string; session: Session }> {
  const jar = await cookies();
  let token = jar.get(COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    if (!create)
      throw new Error("Refresh the page to start your conversation.");
    token = randomBytes(32).toString("hex");
    jar.set(COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 86400,
    });
  }
  const id = createHash("sha256").update(token).digest("hex");
  let session = await getSession(id);
  if (session?.retiredAt) {
    if (!create)
      throw new Error("This conversation was restarted. Refresh to continue.");
    jar.delete(COOKIE);
    return sessionIdentity(true);
  }
  if (!session && create) session = await newSession(id);
  if (!session) throw new Error("Session expired. Refresh to start again.");
  return { id, session };
}
export function requireOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  const expected = process.env.APP_URL
    ? new URL(process.env.APP_URL).origin
    : url.protocol + "//" + (req.headers.get("host") || url.host);
  if (!origin || origin !== expected)
    throw new Error("This request must come from the demo.");
}
export async function jsonBody(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > 65536)
    throw new Error("That message is too long.");
  const text = await req.text();
  if (text.length > 65536) throw new Error("That message is too long.");
  return JSON.parse(text);
}
export function failure(e: unknown, status = 400) {
  const message =
    e instanceof ZodError
      ? "That request wasn’t valid. Please try again."
      : e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name)
        ? "That took longer than expected. Your conversation is saved—try again."
        : e instanceof Error && /^(?:Vercel Blob:|Blob store)/i.test(e.message)
          ? "The demo is temporarily unavailable. Please try again later."
          : e instanceof Error
            ? e.message
            : "Something went wrong. Please try again.";
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export function okay(data: unknown) {
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
