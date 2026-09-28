import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { addMessage, type Session } from "./domain";
import { exclusive, mutateSession, rawStore } from "./store";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export type OAuthAttempt = {
  sessionId: string;
  verifier: string;
  expires: number;
  redirectUri: string;
  used: boolean;
  popup?: boolean;
};
export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expiry: number;
};
function key() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error("Gmail token encryption is not configured.");
  return Buffer.from(value, "hex");
}
export function encryptTokens(value: GoogleTokens) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), bytes]
    .map((x) => x.toString("base64url"))
    .join(".");
}
export function decryptTokens(value: string): GoogleTokens {
  const [iv, tag, bytes] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8"),
  );
}
export function appOrigin(req: Request) {
  return process.env.APP_URL
    ? new URL(process.env.APP_URL).origin
    : new URL(req.url).protocol +
        "//" +
        (req.headers.get("host") || new URL(req.url).host);
}
export async function prepareGoogleAuthorization(
  sessionId: string,
  origin: string,
  options: { popup?: boolean } = {},
) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    throw new Error("Gmail authorization is not configured.");
  key(); // Fail before consent if newly granted tokens could not be stored safely.
  const state = randomBytes(32).toString("hex"),
    verifier = randomBytes(32).toString("base64url"),
    redirectUri = origin + "/api/google/callback";
  await rawStore.write("oauth:" + state, {
    sessionId,
    verifier,
    expires: Date.now() + 600000,
    redirectUri,
    used: false,
    popup: options.popup === true,
  } satisfies OAuthAttempt);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  scope: z.string(),
  expires_in: z.number().finite().positive(),
});
const profileSchema = z.object({ emailAddress: z.email().max(320) });
class RetiredGoogleAuthorization extends Error {
  constructor() {
    super(
      "This conversation was restarted. Connect Gmail from the current conversation.",
    );
  }
}
function requireCurrentConversation(session: Session) {
  if (session.retiredAt) throw new RetiredGoogleAuthorization();
}

// Presentation alone may be read for expired/used attempts so an OAuth error
// cannot accidentally mount a second app in the call's popup. Authorization
// still independently validates expiry and single use below. Query flags do
// not control callback presentation; it is bound to the stored session attempt.
export async function googleAuthorizationPopup(sessionId: string, url: URL) {
  const state = url.searchParams.get("state");
  if (!state || !/^[a-f0-9]{64}$/.test(state)) return undefined;
  const attempt = await rawStore.read<OAuthAttempt>("oauth:" + state);
  if (!attempt || attempt.sessionId !== sessionId) return undefined;
  return attempt.popup === true;
}

export async function completeGoogleAuthorization(
  sessionId: string,
  url: URL,
): Promise<"connected" | "cancelled"> {
  const state = url.searchParams.get("state");
  if (!state || !/^[a-f0-9]{64}$/.test(state))
    throw new Error("Invalid OAuth state");
  const attempt = await exclusive("oauth:" + state, async () => {
    const value = await rawStore.read<OAuthAttempt>("oauth:" + state);
    if (
      !value ||
      value.used ||
      value.expires <= Date.now() ||
      value.sessionId !== sessionId
    )
      throw new Error("Expired or invalid OAuth state");
    value.used = true;
    await rawStore.write("oauth:" + state, value);
    return value;
  });
  const providerError = url.searchParams.get("error");
  if (providerError) {
    if (providerError !== "access_denied")
      throw new Error("Google authorization failed. Please try again.");
    await mutateSession(sessionId, (s) => {
      requireCurrentConversation(s);
      if (s.gmail.status !== "connected") s.gmail.status = "deferred";
      addMessage(s, {
        id: "gmail:" + state,
        role: "event",
        channel: "system",
        text: "Gmail connection cancelled · continuing the conversation",
        at: Date.now(),
      });
    });
    return "cancelled";
  }
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Missing OAuth code");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Google token exchange failed");
  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new Error("Google returned an invalid token response");
  const token = parsed.data;
  if (!token.scope.split(/\s+/).includes(GMAIL_SCOPE))
    throw new Error("Gmail permission not granted");
  const profileResponse = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!profileResponse.ok) throw new Error("Could not verify Gmail");
  const profile = profileSchema.safeParse(await profileResponse.json());
  if (!profile.success)
    throw new Error("Google returned no valid Gmail address");
  try {
    await mutateSession(sessionId, (s) => {
      // Identity was checked before the provider requests. Reset may have
      // retired it while token exchange/profile verification was in flight.
      requireCurrentConversation(s);
      // Google may omit a previously issued refresh token on a later grant.
      const previousRefreshToken =
        !token.refresh_token &&
        s.gmail.email === profile.data.emailAddress &&
        s.gmail.encryptedTokens
          ? decryptTokens(s.gmail.encryptedTokens).refresh_token
          : undefined;
      s.gmail = {
        status: "connected",
        email: profile.data.emailAddress,
        encryptedTokens: encryptTokens({
          access_token: token.access_token,
          refresh_token: token.refresh_token || previousRefreshToken,
          expiry: Date.now() + token.expires_in * 1000,
        }),
      };
      addMessage(s, {
        id: "gmail:" + state,
        role: "event",
        channel: "system",
        text: `Gmail connected · ${profile.data.emailAddress}`,
        at: Date.now(),
      });
    });
  } catch (e) {
    if (e instanceof RetiredGoogleAuthorization) {
      // Revoke only a token from this just-completed grant, never an older
      // stored credential. A reset must not leave a new, unreachable token.
      await revokeToken(token.refresh_token || token.access_token).catch(() => {
        console.error("Retired Gmail authorization token cleanup failed");
      });
    }
    throw e;
  }
  return "connected";
}

export async function revokeToken(token: string) {
  const r = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    // Only an already-invalid token makes revocation safely idempotent.
    const error = r.status === 400 ? await r.json().catch(() => null) : null;
    if (error?.error === "invalid_token") return;
    throw new Error(
      "Google couldn’t revoke access just now. Try again, or revoke it in your Google account settings.",
    );
  }
}
