import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  completeGoogleAuthorization,
  decryptTokens,
  encryptTokens,
  GMAIL_SCOPE,
  prepareGoogleAuthorization,
  googleAuthorizationPopup,
  revokeToken,
  type OAuthAttempt,
} from "../src/lib/google";
import {
  getSession,
  mutateSession,
  newSession,
  rawStore,
} from "../src/lib/store";
import { publicSession } from "../src/lib/domain";

// No live Google requests or credentials are used by these provider-contract tests.
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
process.env.TOKEN_ENCRYPTION_KEY = "b".repeat(64);
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
delete process.env.VERCEL;
const origin = "https://persona.example";
const validToken = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  token_type: "Bearer",
  scope: GMAIL_SCOPE,
  expires_in: 3600,
};
async function fixture(t: TestContext, existingId?: string, popup = false) {
  const id = existingId || "google-test-" + randomUUID();
  if (!existingId) await newSession(id);
  const authorization = await prepareGoogleAuthorization(id, origin, { popup });
  const state = authorization.searchParams.get("state")!;
  const attempt = (await rawStore.read<OAuthAttempt>("oauth:" + state))!;
  t.after(async () => {
    for (const key of ["session:" + id, "oauth:" + state])
      await unlink(
        path.join(process.cwd(), ".data", encodeURIComponent(key) + ".json"),
      ).catch(() => {});
  });
  const callback = new URL(origin + "/api/google/callback");
  callback.search = new URLSearchParams({
    state,
    code: "test-authorization-code",
  }).toString();
  return { id, authorization, state, attempt, callback };
}
function provider(
  t: TestContext,
  options: {
    token?: unknown;
    profile?: unknown;
    tokenStatus?: number;
    profileStatus?: number;
  } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json(options.token ?? validToken, {
          status: options.tokenStatus || 200,
        });
      if (
        url ===
        "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress"
      )
        return Response.json(
          options.profile ?? { emailAddress: "verified@gmail.com" },
          { status: options.profileStatus || 200 },
        );
      throw new Error("Unexpected provider request: " + url);
    },
  );
  return calls;
}

test("Google authorization requests Gmail only and binds PKCE to the stored attempt", async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  const params = first.authorization.searchParams;
  assert.equal(first.authorization.origin, "https://accounts.google.com");
  assert.equal(params.get("scope"), GMAIL_SCOPE);
  assert.equal(params.get("redirect_uri"), origin + "/api/google/callback");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(
    params.get("code_challenge"),
    createHash("sha256").update(first.attempt.verifier).digest("base64url"),
  );
  assert.match(first.attempt.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.attempt.sessionId, first.id);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.attempt.verifier, second.attempt.verifier);
  assert.ok(
    first.attempt.expires > Date.now() &&
      first.attempt.expires <= Date.now() + 600000,
  );
  assert.equal(params.get("access_type"), "offline");
});

test("callbacks reject malformed, foreign-session, expired, and consumed state before provider calls", async (t) => {
  const calls = provider(t);
  const f = await fixture(t);
  await assert.rejects(
    completeGoogleAuthorization(
      f.id,
      new URL(origin + "/api/google/callback?state=bad&code=x"),
    ),
    /state/,
  );
  await assert.rejects(
    completeGoogleAuthorization("another-session", f.callback),
    /state/,
  );
  assert.equal(
    (await rawStore.read<OAuthAttempt>("oauth:" + f.state))!.used,
    false,
  );
  await rawStore.write("oauth:" + f.state, {
    ...f.attempt,
    expires: Date.now() - 1,
  });
  await assert.rejects(completeGoogleAuthorization(f.id, f.callback), /state/);
  await rawStore.write("oauth:" + f.state, { ...f.attempt, used: true });
  await assert.rejects(completeGoogleAuthorization(f.id, f.callback), /state/);
  assert.equal(calls.length, 0);
  assert.equal((await getSession(f.id))!.gmail.status, "unknown");
});

test("a successful callback verifies Gmail, keeps tokens encrypted, and permits only one concurrent exchange", async (t) => {
  const calls = provider(t);
  const f = await fixture(t);
  f.callback.searchParams.set("emailAddress", "spoofed@attacker.example");
  const results = await Promise.allSettled([
    completeGoogleAuthorization(f.id, f.callback),
    completeGoogleAuthorization(f.id, f.callback),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls.length, 2);
  const exchange = calls[0].init!;
  const body = exchange.body as URLSearchParams;
  assert.equal(exchange.method, "POST");
  assert.equal(body.get("code_verifier"), f.attempt.verifier);
  assert.equal(body.get("redirect_uri"), f.attempt.redirectUri);
  assert.equal(body.get("code"), "test-authorization-code");
  assert.equal(
    (calls[1].init!.headers as Record<string, string>).Authorization,
    "Bearer test-access-token",
  );
  const session = (await getSession(f.id))!;
  assert.equal(session.gmail.status, "connected");
  assert.equal(session.gmail.email, "verified@gmail.com");
  assert.ok(!session.gmail.encryptedTokens!.includes(validToken.access_token));
  assert.equal(
    decryptTokens(session.gmail.encryptedTokens!).refresh_token,
    validToken.refresh_token,
  );
  assert.ok(
    !JSON.stringify(publicSession(session)).includes("encryptedTokens"),
  );
  assert.equal(
    session.messages.filter((m) => m.id === "gmail:" + f.state).length,
    1,
  );
});

test("consent cancellation is distinct from provider failure and preserves a prior connection", async (t) => {
  const calls = provider(t);
  const cancelled = await fixture(t);
  cancelled.callback.searchParams.set("error", "access_denied");
  cancelled.callback.searchParams.delete("code");
  assert.equal(
    await completeGoogleAuthorization(cancelled.id, cancelled.callback),
    "cancelled",
  );
  assert.equal((await getSession(cancelled.id))!.gmail.status, "deferred");
  const connected = await fixture(t);
  await mutateSession(connected.id, (s) => {
    s.gmail = { status: "connected", email: "existing@gmail.com" };
  });
  connected.callback.searchParams.set("error", "access_denied");
  await completeGoogleAuthorization(connected.id, connected.callback);
  assert.equal(
    (await getSession(connected.id))!.gmail.email,
    "existing@gmail.com",
  );
  const failure = await fixture(t);
  failure.callback.searchParams.set("error", "server_error");
  await assert.rejects(
    completeGoogleAuthorization(failure.id, failure.callback),
    /authorization failed/,
  );
  assert.equal((await getSession(failure.id))!.gmail.status, "unknown");
  assert.equal((await getSession(failure.id))!.messages.length, 1);
  assert.equal(calls.length, 0);
});

test("reset during Google verification rejects connection and revokes only the new grant", async (t) => {
  for (const cleanupFails of [false, true]) {
    const f = await fixture(t, undefined, true);
    const next = await fixture(t);
    let release!: () => void;
    let entered!: () => void;
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    t.mock.method(console, "error", () => {});
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://oauth2.googleapis.com/token")
          return Response.json({
            ...validToken,
            refresh_token: cleanupFails ? undefined : validToken.refresh_token,
          });
        if (
          url ===
          "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress"
        ) {
          entered();
          await blocked;
          return Response.json({ emailAddress: "verified@gmail.com" });
        }
        assert.equal(url, "https://oauth2.googleapis.com/revoke");
        assert.equal(
          (init!.body as URLSearchParams).get("token"),
          cleanupFails ? validToken.access_token : validToken.refresh_token,
        );
        return Response.json({}, { status: cleanupFails ? 503 : 200 });
      },
    );
    const completion = completeGoogleAuthorization(f.id, f.callback);
    await verifying;
    await mutateSession(f.id, (s) => {
      s.retiredAt = Date.now();
    });
    release();
    await assert.rejects(completion, /conversation was restarted/);
    const retired = (await getSession(f.id))!;
    assert.ok(retired.retiredAt);
    assert.equal(retired.gmail.status, "unknown");
    assert.equal(retired.gmail.encryptedTokens, undefined);
    assert.ok(!retired.messages.some((m) => m.id === "gmail:" + f.state));
    assert.equal((await getSession(next.id))!.gmail.status, "unknown");
    assert.equal(
      calls.length,
      3,
      "newly issued token gets one bounded cleanup attempt",
    );
    assert.equal(
      (await rawStore.read<OAuthAttempt>("oauth:" + f.state))!.used,
      true,
    );
    t.mock.restoreAll();
  }
});

test("cancelled Google consent cannot mutate a conversation retired after identity lookup", async (t) => {
  const calls = provider(t);
  const f = await fixture(t, undefined, true);
  await mutateSession(f.id, (s) => {
    s.retiredAt = Date.now();
  });
  const before = (await getSession(f.id))!;
  f.callback.searchParams.delete("code");
  f.callback.searchParams.set("error", "access_denied");
  await assert.rejects(
    completeGoogleAuthorization(f.id, f.callback),
    /conversation was restarted/,
  );
  const after = (await getSession(f.id))!;
  assert.deepEqual(after.gmail, before.gmail);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.revision, before.revision);
  assert.equal(calls.length, 0);
});

test("failed token exchange, missing permission, and invalid Gmail profiles never become connected", async (t) => {
  for (const options of [
    { tokenStatus: 400 },
    { token: { ...validToken, access_token: 123 } },
    { token: { ...validToken, expires_in: -1 } },
    { token: { ...validToken, scope: "openid email" } },
    { token: { ...validToken, token_type: "not-bearer" } },
    { profileStatus: 403 },
    { profile: { emailAddress: "not an email" } },
  ]) {
    const calls = provider(t, options);
    const f = await fixture(t);
    await assert.rejects(completeGoogleAuthorization(f.id, f.callback));
    const session = (await getSession(f.id))!;
    assert.equal(session.gmail.status, "unknown");
    assert.equal(session.gmail.encryptedTokens, undefined);
    assert.equal(
      (await rawStore.read<OAuthAttempt>("oauth:" + f.state))!.used,
      true,
    );
    assert.ok(calls.length <= 2);
    t.mock.restoreAll();
  }
});

test("reconnecting preserves an omitted refresh token only for the same verified account", async (t) => {
  const { refresh_token: _refresh, ...token } = validToken;
  provider(t, { token });
  const same = await fixture(t);
  await mutateSession(same.id, (s) => {
    s.gmail = {
      status: "connected",
      email: "verified@gmail.com",
      encryptedTokens: encryptTokens({
        access_token: "old-access",
        refresh_token: "old-refresh",
        expiry: 1,
      }),
    };
  });
  await completeGoogleAuthorization(same.id, same.callback);
  assert.equal(
    decryptTokens((await getSession(same.id))!.gmail.encryptedTokens!)
      .refresh_token,
    "old-refresh",
  );
  const different = await fixture(t);
  await mutateSession(different.id, (s) => {
    s.gmail = {
      status: "connected",
      email: "someone-else@gmail.com",
      encryptedTokens: encryptTokens({
        access_token: "other-access",
        refresh_token: "other-refresh",
        expiry: 1,
      }),
    };
  });
  await completeGoogleAuthorization(different.id, different.callback);
  assert.equal(
    decryptTokens((await getSession(different.id))!.gmail.encryptedTokens!)
      .refresh_token,
    undefined,
  );
});

test("revocation accepts an already-invalid token but does not hide other Google failures", async (t) => {
  let status = 200,
    response: unknown = {};
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://oauth2.googleapis.com/revoke");
      assert.equal(init!.method, "POST");
      assert.equal((init!.body as URLSearchParams).get("token"), "test-token");
      return Response.json(response, { status });
    },
  );
  await revokeToken("test-token");
  status = 400;
  response = { error: "invalid_token" };
  await revokeToken("test-token");
  response = { error: "invalid_request" };
  await assert.rejects(revokeToken("test-token"), /couldn’t revoke/);
  status = 503;
  await assert.rejects(revokeToken("test-token"), /couldn’t revoke/);
});

test("popup return mode is bound to the stored OAuth session, never callback query flags", async (t) => {
  const popup = await fixture(t, undefined, true);
  assert.equal(popup.attempt.popup, true);
  assert.equal(
    popup.authorization.searchParams.get("redirect_uri"),
    origin + "/api/google/callback",
  );
  popup.callback.searchParams.set("popup", "0");
  assert.equal(await googleAuthorizationPopup(popup.id, popup.callback), true);
  assert.equal(
    await googleAuthorizationPopup("foreign-session", popup.callback),
    undefined,
  );
  const normal = await fixture(t);
  normal.callback.searchParams.set("popup", "1");
  assert.equal(
    await googleAuthorizationPopup(normal.id, normal.callback),
    false,
  );
  assert.equal(
    await googleAuthorizationPopup(
      normal.id,
      new URL(origin + "/api/google/callback?state=bad&popup=1"),
    ),
    undefined,
  );
});

test("popup cancellation and expired-state errors retain presentation without bypassing authorization", async (t) => {
  const calls = provider(t);
  const popup = await fixture(t, undefined, true);
  popup.callback.searchParams.delete("code");
  popup.callback.searchParams.set("error", "access_denied");
  assert.equal(
    await completeGoogleAuthorization(popup.id, popup.callback),
    "cancelled",
  );
  assert.equal(await googleAuthorizationPopup(popup.id, popup.callback), true);
  assert.equal((await getSession(popup.id))!.gmail.status, "deferred");
  await assert.rejects(
    completeGoogleAuthorization(popup.id, popup.callback),
    /state/,
  );
  const expired = await fixture(t, undefined, true);
  await rawStore.write("oauth:" + expired.state, {
    ...expired.attempt,
    expires: Date.now() - 1,
  });
  assert.equal(
    await googleAuthorizationPopup(expired.id, expired.callback),
    true,
  );
  await assert.rejects(
    completeGoogleAuthorization(expired.id, expired.callback),
    /state/,
  );
  assert.equal(calls.length, 0);
});
