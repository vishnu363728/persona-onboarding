import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  publicSession,
  type PublicSession,
} from "../src/lib/domain";
import { all, content, deferred, mountUI, tick } from "./persona-ui-fixture";

const saved = () => publicSession(createSession("ui-test"));
async function mount(session = saved(), scroll = false) {
  const ui = mountUI({ session, scroll });
  ui.render();
  ui.commit();
  await ui.flush();
  return ui;
}
type UI = Awaited<ReturnType<typeof mount>>;

test("voice transcripts stay out of chat bubbles during and after a call without removing saved context", async () => {
  for (const active of [true, false]) {
    const session = saved();
    session.call = { status: active ? "active" : "ended", attempts: 1, id: "call-fixture" };
    session.messages.push(
      { id: "typed", role: "user", channel: "text", text: "Keep this typed message", at: 1 },
      { id: "spoken-user", role: "user", channel: "voice", text: "Spoken user transcript", at: 2 },
      { id: "spoken-agent", role: "assistant", channel: "voice", text: "Spoken assistant transcript", at: 3, interrupted: true },
      { id: "call-event", role: "event", channel: "system", text: "Audio call ended", at: 4 },
      { id: "typed-reply", role: "assistant", channel: "text", text: "Keep this text reply", at: 5 },
    );
    const original = structuredClone(session.messages);
    const ui = mountUI({ session, ...(active ? { voice: "active" as const } : {}) });
    ui.render();
    ui.commit();
    await ui.flush();
    try {
      const chat = ui.find((el) => el.props.role === "log");
      assert.match(content(chat), /Keep this typed message/);
      assert.equal(all(chat, (el) => el.props["data-message-id"] === "typed-reply").length, 1);
      assert.match(content(chat), /Audio call ended/);
      assert.doesNotMatch(content(chat), /Spoken user transcript|Spoken assistant transcript|From your call/);
      assert.equal(all(chat, (el) => ["spoken-user", "spoken-agent"].includes(el.props["data-message-id"])).length, 0);
      assert.deepEqual(session.messages, original, "saved transcripts remain available for server context");
    } finally {
      ui.dispose();
    }
  }
});

test("Gmail retries show one final result without erasing conversation history", async () => {
  const session = saved();
  const events = [
    "Gmail connection cancelled · continuing the conversation",
    "Gmail connected · test@example.com",
    "Gmail disconnected",
  ];
  session.messages.push(
    ...events.map((text, i) => ({
      id: `gmail:${i}`,
      role: "event" as const,
      channel: "system" as const,
      text,
      at: Date.now() + i,
    })),
  );
  const ui = await mount(session);
  try {
    const statuses = all(
      ui.tree,
      (el) => el.props.className === "system-message",
    );
    assert.deepEqual(statuses.map(content), ["Gmail disconnected"]);
    assert.equal(session.messages.length, 4, "stored history is preserved");
  } finally {
    ui.dispose();
  }
});

test("Gmail status keeps conversation boundaries and leaves quoted user text alone", async () => {
  const session = saved();
  session.messages.push(
    {
      id: "gmail:connected",
      role: "event",
      channel: "system",
      text: "Gmail connected · test@example.com",
      at: 1,
    },
    {
      id: "user",
      role: "user",
      channel: "text",
      text: "Gmail connected · a quote",
      at: 2,
    },
    {
      id: "gmail:cancelled",
      role: "event",
      channel: "system",
      text: "Gmail connection cancelled · continuing the conversation",
      at: 3,
    },
  );
  const ui = await mount(session);
  try {
    const statuses = all(
      ui.tree,
      (el) => el.props.className === "system-message",
    );
    assert.deepEqual(statuses.map(content), [
      "Gmail connected",
      "Gmail left for later",
    ]);
    assert.match(content(ui.tree), /Gmail connected · a quote/);
    assert.doesNotMatch(content(ui.tree), /test@example\.com/);
  } finally {
    ui.dispose();
  }
});
function paint(ui: UI) {
  ui.render();
  ui.commit();
}
function type(ui: UI, text: string) {
  ui.textarea().props.onChange({ target: { value: text } });
  paint(ui);
}
function submit(ui: UI) {
  ui.find((el) => el.type === "form").props.onSubmit({ preventDefault() {} });
  paint(ui);
}
function reset(ui: UI) {
  ui.button("About Persona").props.onClick();
  paint(ui);
  ui.button("New conversation").props.onClick();
  paint(ui);
  ui.button("Start fresh? This opens a new conversation.").props.onClick();
  paint(ui);
}
function reply(session: PublicSession, id: string, text: string) {
  return {
    session: {
      ...session,
      revision: session.revision + 1,
      messages: [
        ...session.messages,
        {
          id: "reply:" + id,
          text,
          role: "assistant",
          channel: "text",
          at: Date.now(),
        },
      ],
    },
  };
}

test("details make the incoming call inert and restore keyboard focus on close", async () => {
  const session = saved();
  session.call = { status: "ringing", attempts: 1, startedAt: Date.now() };
  const ui = await mount(session);
  try {
    ui.button("About Persona").props.onClick();
    paint(ui);
    const incoming = ui.find((el) => el.props.className === "incoming-banner");
    assert.equal(incoming.props.inert, true);
    assert.equal(incoming.props["aria-hidden"], true);
    assert.equal(
      ui.find((el) => el.props.className === "composer-area").props.inert,
      true,
    );
    ui.button("Close details").props.onClick();
    paint(ui);
    assert.equal(
      ui.find((el) => el.props.className === "incoming-banner").props.inert,
      false,
    );
    assert.equal(ui.focusCount, 1);
  } finally {
    ui.dispose();
  }
});

test("composer keeps Shift+Enter and IME input local, while Enter sends once", async () => {
  const ui = await mount(),
    response = deferred<unknown>();
  ui.api["/api/chat"] = () => response.promise;
  try {
    type(ui, "A thought in progress");
    const keydown = ui.textarea().props.onKeyDown;
    let prevented = 0;
    const key = {
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      keyCode: 13,
      preventDefault() {
        prevented++;
      },
    };
    keydown({ ...key, shiftKey: true });
    keydown({ ...key, nativeEvent: { isComposing: true } });
    keydown({ ...key, keyCode: 229 });
    assert.equal(ui.requests.filter((r) => r.path === "/api/chat").length, 0);
    assert.equal(prevented, 0);
    keydown(key);
    keydown(key);
    paint(ui);
    assert.equal(ui.requests.filter((r) => r.path === "/api/chat").length, 1);
    assert.ok(prevented > 0, "a submitted Enter must not insert a newline");
  } finally {
    ui.dispose();
  }
});

test("repeated decline clicks share one mutation and one text recovery", async () => {
  const session = saved();
  session.call = { status: "ringing", attempts: 1, startedAt: Date.now() };
  const ui = await mount(session),
    response = deferred<unknown>();
  ui.api["/api/events"] = () => response.promise;
  try {
    const decline = ui.button("Decline call").props.onClick;
    decline();
    decline();
    await tick();
    paint(ui);
    assert.equal(ui.requests.filter((r) => r.path === "/api/events").length, 1);
    assert.equal(ui.button("Decline call").props.disabled, true);
    assert.equal(ui.button("Accept call").props.disabled, true);
    response.resolve({
      session: {
        ...session,
        revision: 1,
        call: { ...session.call, status: "declined" },
      },
    });
    await ui.flush();
    assert.equal(ui.button("Decline call"), undefined);
    ui.runTimer(650);
    await ui.flush();
    assert.equal(ui.requests.filter((r) => r.path === "/api/chat").length, 1);
  } finally {
    ui.dispose();
  }
});

test("confirmed reset aborts pending chat and its late completion cannot unlock a new send", async () => {
  const initial = saved(),
    fresh = saved();
  fresh.createdAt = initial.createdAt + 1;
  const ui = await mount(initial),
    old = deferred<unknown>(),
    next = deferred<unknown>();
  let calls = 0;
  ui.api["/api/chat"] = () => (++calls === 1 ? old.promise : next.promise);
  ui.api["/api/reset"] = async () => {
    ui.session = fresh;
    return { session: fresh };
  };
  try {
    type(ui, "first message");
    const send = ui.find((el) => el.type === "form").props.onSubmit;
    send({ preventDefault() {} });
    send({ preventDefault() {} });
    paint(ui);
    assert.equal(calls, 1);
    const first = ui.requests.find((r) => r.path === "/api/chat")!;
    reset(ui);
    await ui.flush();
    assert.equal(first.signal?.aborted, true);
    assert.equal(ui.storage.has("persona-pending"), false);
    assert.equal(ui.textarea().props.value, "");
    type(ui, "new conversation message");
    submit(ui);
    type(ui, "keep this draft");
    old.resolve(reply(initial, String(first.body.id), "Obsolete answer"));
    await ui.flush();
    assert.equal(
      ui.button("Send message").props.disabled,
      true,
      "old finalizer must not unlock current send",
    );
    assert.ok(
      ui.find((el) => el.props.className === "bubble assistant typing"),
    );
    assert.doesNotMatch(content(ui.tree), /Obsolete answer/);
    const second = ui.requests.filter((r) => r.path === "/api/chat")[1];
    next.resolve(reply(fresh, String(second.body.id), "Current answer"));
    await ui.flush();
    assert.equal(ui.button("Send message").props.disabled, false);
    assert.equal(ui.textarea().props.value, "keep this draft");
  } finally {
    ui.dispose();
  }
});

test("reset errors close the sheet so recovery stays visible", async () => {
  const ui = await mount();
  ui.api["/api/reset"] = async () => {
    throw new Error("Connection was interrupted");
  };
  try {
    reset(ui);
    await ui.flush();
    assert.equal(ui.button("Close details"), undefined);
    assert.match(
      content(ui.find((el) => el.props.role === "alert")),
      /Connection was interrupted/,
    );
    assert.equal(ui.textarea().props.disabled, false);
  } finally {
    ui.dispose();
  }
});

test("failed send retries the same ID once and preserves a newer draft", async () => {
  const session = saved(),
    ui = await mount(session),
    response = deferred<unknown>();
  let calls = 0;
  ui.api["/api/chat"] = async () => {
    if (++calls === 1) throw new Error("Lost connection");
    return response.promise;
  };
  try {
    type(ui, "please remember this");
    submit(ui);
    type(ui, "next unsent thought");
    await ui.flush();
    const first = ui.requests.find((r) => r.path === "/api/chat")!;
    const retry = ui.button("Retry message").props.onClick;
    retry();
    retry();
    paint(ui);
    const sends = ui.requests.filter((r) => r.path === "/api/chat");
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[1].body, first.body);
    response.resolve(reply(session, String(first.body.id), "I have it."));
    await ui.flush();
    assert.equal(ui.storage.has("persona-pending"), false);
    assert.equal(ui.textarea().props.value, "next unsent thought");
    assert.equal(ui.button("Send message").props.disabled, false);
  } finally {
    ui.dispose();
  }
});

test("non-retryable conflicts recover an editable message with a fresh request ID", async () => {
  const ui = await mount();
  ui.api["/api/chat"] = async () => ({
    responseStatus: 409,
    retryable: false,
    error: "A newer message has already continued this conversation.",
  });
  try {
    type(ui, "send this again");
    submit(ui);
    await ui.flush();
    const first = ui.requests.find((r) => r.path === "/api/chat")!;
    assert.equal(ui.textarea().props.value, "send this again");
    assert.equal(ui.storage.has("persona-pending"), false);
    assert.equal(ui.button("Retry message"), undefined);
    assert.equal(ui.button("Send message").props.disabled, false);
    submit(ui);
    await ui.flush();
    assert.notEqual(
      ui.requests.filter((r) => r.path === "/api/chat")[1].body.id,
      first.body.id,
    );
    const late = deferred<unknown>();
    ui.api["/api/chat"] = () => late.promise;
    submit(ui);
    type(ui, "newer draft wins");
    late.resolve({
      responseStatus: 409,
      retryable: false,
      error: "Message already continued.",
    });
    await ui.flush();
    assert.equal(ui.textarea().props.value, "newer draft wins");
  } finally {
    ui.dispose();
  }
});

test("a stale disconnect failure cannot close the new conversation's details", async () => {
  const session = saved();
  session.gmail = { status: "connected", email: "test@example.com" };
  const fresh = saved();
  fresh.createdAt = session.createdAt + 1;
  const ui = await mount(session),
    disconnect = deferred<unknown>();
  ui.api["/api/google/disconnect"] = () => disconnect.promise;
  ui.api["/api/reset"] = async () => {
    ui.session = fresh;
    return { session: fresh };
  };
  try {
    ui.button("About Persona").props.onClick();
    paint(ui);
    const action = ui.button("Disconnect Gmail").props.onClick;
    void action();
    void action();
    await tick();
    paint(ui);
    assert.equal(
      ui.requests.filter((r) => r.path === "/api/google/disconnect").length,
      1,
    );
    assert.equal(ui.button("Disconnecting…").props.disabled, true);
    ui.button("New conversation").props.onClick();
    paint(ui);
    ui.button("Start fresh? This opens a new conversation.").props.onClick();
    await ui.flush();
    ui.button("About Persona").props.onClick();
    paint(ui);
    disconnect.reject(new Error("Old disconnect failed"));
    await ui.flush();
    assert.ok(ui.button("Close details"));
    assert.doesNotMatch(content(ui.tree), /Old disconnect failed/);
  } finally {
    ui.dispose();
  }
});

test("rolling history preserves the visible message and exposes a latest-message jump", async () => {
  const session = saved();
  session.messages = Array.from({ length: 4 }, (_, n) => ({
    id: String(n),
    role: "assistant" as const,
    channel: "text" as const,
    text: `Message ${n}`,
    at: n,
  }));
  const ui = await mount(session, true);
  try {
    assert.equal(ui.view.scrollTop, 250);
    ui.view.scrollTop = 150;
    ui.find((el) => el.props.className === "message-scroll").props.onScroll({
      currentTarget: ui.view,
    });
    ui.session = {
      ...session,
      revision: 1,
      historyTrimmed: 1,
      messages: [
        ...session.messages.slice(1),
        { ...session.messages[0], id: "4", text: "New reply" },
      ],
    };
    ui.runTimer(45000, true);
    await ui.flush();
    assert.equal(
      ui.view.scrollTop,
      50,
      "visible message keeps its position when the first message is trimmed",
    );
    assert.ok(ui.button("Latest messages"));
    assert.match(content(ui.tree), /Earlier messages are no longer shown/);
    ui.button("Latest messages").props.onClick();
    paint(ui);
    assert.equal(ui.view.scrollTop, 250);
    assert.equal(ui.button("Latest messages"), undefined);
  } finally {
    ui.dispose();
  }
});

async function gmailUI(
  options: {
    voice?: "active";
    popupBlocked?: boolean;
    search?: string;
    status?: PublicSession["gmail"]["status"];
    draft?: string;
  } = {},
) {
  const session = saved();
  session.gmail = { status: options.status || "offered" };
  if (options.voice)
    session.call = { status: "active", attempts: 1, id: "call-fixture" };
  const ui = mountUI({
    session,
    scroll: true,
    storage: new Map([["persona-draft", options.draft || ""]]),
    ...options,
  });
  ui.render();
  ui.commit();
  await ui.flush();
  return ui;
}

test("call Gmail handoff reveals and focuses the card without ending the call", async () => {
  const ui = await gmailUI({ voice: "active" });
  try {
    ui.view.scrollTop = 0;
    ui.find((el) => el.props.className === "message-scroll").props.onScroll({
      currentTarget: ui.view,
    });
    ui.button("View Gmail connection").props.onClick();
    paint(ui);
    assert.equal(
      ui.find((el) => el.props.className === "call-screen"),
      undefined,
    );
    assert.ok(ui.find((el) => el.props.className === "return-call"));
    assert.ok(ui.view.scrollTop > 0);
    assert.equal(ui.focused.trim(), "Connect Gmail");
    assert.equal(ui.textarea().props.disabled, true, "the live call continues");
    assert.equal(ui.requests.filter((r) => r.path.includes("/end")).length, 0);
  } finally {
    ui.dispose();
  }
});

test("active-call Gmail opens one isolated window and preserves call and draft", async () => {
  const ui = await gmailUI({ voice: "active", draft: "saved draft" });
  try {
    ui.button("View Gmail connection").props.onClick();
    paint(ui);
    const connect = ui.button("Connect Gmail").props.onClick;
    connect();
    connect();
    paint(ui);
    assert.equal(ui.popupCount, 1);
    assert.equal(ui.popup.opener, null);
    assert.equal(ui.popup.location.href, "/api/google/start?popup=1");
    assert.equal(ui.popup.focusCount, 1);
    assert.equal(ui.storage.get("persona-draft"), "saved draft");
    assert.ok(ui.button("Return to Google"));
    assert.match(content(ui.tree), /Your call is still connected/);
    assert.equal(ui.requests.filter((r) => r.path.includes("/end")).length, 0);
    assert.equal(
      (globalThis.location as unknown as { href?: string }).href,
      undefined,
    );
  } finally {
    ui.dispose();
  }
});

test("blocked Google windows leave the live call and an actionable retry intact", async () => {
  const ui = await gmailUI({ voice: "active", popupBlocked: true });
  try {
    ui.button("View Gmail connection").props.onClick();
    paint(ui);
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    assert.match(content(ui.tree), /browser blocked the Google window/);
    assert.ok(ui.button("Connect Gmail"));
    assert.equal(ui.textarea().props.disabled, true);
    assert.equal(
      (globalThis.location as unknown as { href?: string }).href,
      undefined,
    );
  } finally {
    ui.dispose();
  }
});

test("closing Google allows retry, while a verified connection removes the pending card", async () => {
  const ui = await gmailUI({ voice: "active" });
  try {
    ui.button("View Gmail connection").props.onClick();
    paint(ui);
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    ui.popup.closed = true;
    ui.runTimer(1000, true);
    await ui.flush();
    assert.ok(ui.button("Connect Gmail"));
    assert.match(content(ui.tree), /Google window closed/);
    ui.popup.closed = false;
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    ui.session = {
      ...ui.session!,
      revision: 1,
      gmail: { status: "connected", email: "test@example.com" },
    };
    ui.runTimer(2500, true);
    await ui.flush();
    assert.equal(
      ui.find((el) => el.props.className === "gmail-card"),
      undefined,
    );
    assert.doesNotMatch(content(ui.tree), /Google is open/);
    assert.equal(ui.textarea().props.disabled, true);
  } finally {
    ui.dispose();
  }
});

test("OAuth errors bring back the connection card; text connection preserves the draft", async () => {
  const ui = await gmailUI({ search: "?gmail=error", status: "deferred" });
  try {
    assert.ok(ui.button("Connect Gmail"));
    type(ui, "A thought to return to");
    ui.button("Connect Gmail").props.onClick();
    assert.equal(ui.storage.get("persona-draft"), "A thought to return to");
    assert.equal(
      (globalThis.location as unknown as { href?: string }).href,
      "/api/google/start",
    );
    assert.equal(ui.popupCount, 0);
  } finally {
    ui.dispose();
  }
});

test("cancelling Google respects deferral and avoids a duplicate cancellation notice", async () => {
  const ui = await gmailUI({ search: "?gmail=cancelled", status: "deferred" });
  try {
    assert.equal(
      ui.find((el) => el.props.className === "gmail-card"),
      undefined,
    );
    assert.equal(
      ui.find((el) => el.props.className === "notice"),
      undefined,
    );
    assert.equal(ui.textarea().props.disabled, false);
  } finally {
    ui.dispose();
  }
});

test("a retry from a previously deferred connection stays open during a call", async () => {
  const ui = await gmailUI({
    search: "?gmail=error",
    status: "deferred",
    voice: "active",
  });
  try {
    ui.button("Return to messages").props.onClick();
    paint(ui);
    ui.button("Connect Gmail").props.onClick();
    await ui.flush();
    assert.ok(ui.button("Return to Google"));
    assert.equal(ui.popupCount, 1);
    assert.equal(ui.popup.closed, false);
  } finally {
    ui.dispose();
  }
});

test("an older popup-close response cannot overwrite the newer attempt's recovery", async () => {
  const ui = await gmailUI({ voice: "active" });
  const first = deferred<unknown>(),
    second = deferred<unknown>();
  let reads = 0;
  try {
    ui.button("View Gmail connection").props.onClick();
    paint(ui);
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    ui.api["/api/session"] = () =>
      ++reads === 1 ? first.promise : second.promise;
    ui.popup.closed = true;
    ui.runTimer(1000, true);
    paint(ui);
    ui.popup.closed = false;
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    ui.popup.closed = true;
    ui.runTimer(1000, true);
    paint(ui);
    second.reject(new Error("Simulated lookup failure"));
    await ui.flush();
    assert.match(content(ui.tree), /couldn’t check the connection/);
    first.resolve({
      session: ui.session,
      capabilities: { text: true, voice: true, gmail: true },
    });
    await ui.flush();
    assert.match(content(ui.tree), /couldn’t check the connection/);
    assert.doesNotMatch(content(ui.tree), /Google window closed/);
    assert.equal(ui.popupCount, 2);
  } finally {
    ui.dispose();
  }
});

test("a conversation reset observed from another tab invalidates the old popup handle", async () => {
  const ui = await gmailUI({ voice: "active" });
  try {
    ui.button("View Gmail connection").props.onClick();
    paint(ui);
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    ui.session = {
      ...ui.session!,
      createdAt: ui.session!.createdAt + 1,
      revision: 0,
    };
    ui.runTimer(2500, true);
    await ui.flush();
    assert.equal(ui.button("Return to Google"), undefined);
    assert.equal(
      ui.popup.closed,
      false,
      "the old Google window is never forcibly closed",
    );
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    assert.equal(
      ui.popupCount,
      2,
      "the new conversation must not reuse the old consent attempt",
    );
  } finally {
    ui.dispose();
  }
});

test("late popup checks after local reset cannot restore old connection feedback", async () => {
  const ui = await gmailUI({ voice: "active", draft: "old draft" }),
    response = deferred<unknown>();
  const fresh = saved();
  fresh.createdAt = ui.session!.createdAt + 1;
  try {
    ui.button("View Gmail connection").props.onClick();
    paint(ui);
    ui.button("Connect Gmail").props.onClick();
    paint(ui);
    ui.api["/api/session"] = () => response.promise;
    ui.popup.closed = true;
    ui.runTimer(1000, true);
    paint(ui);
    ui.api["/api/reset"] = async () => ({ session: fresh });
    reset(ui);
    await ui.flush();
    response.reject(new Error("Old request failed"));
    await ui.flush();
    assert.doesNotMatch(
      content(ui.tree),
      /couldn’t check|Google window closed|Old request failed/,
    );
    assert.equal(ui.textarea().props.value, "");
    assert.equal(
      ui.find((el) => el.props.className === "gmail-card"),
      undefined,
    );
  } finally {
    ui.dispose();
  }
});

test("an in-flight popup refresh performs no component state writes after unmount", async () => {
  const ui = await gmailUI({ voice: "active" }),
    response = deferred<unknown>();
  ui.button("View Gmail connection").props.onClick();
  paint(ui);
  ui.button("Connect Gmail").props.onClick();
  paint(ui);
  ui.api["/api/session"] = () => response.promise;
  ui.popup.closed = true;
  ui.runTimer(1000, true);
  ui.dispose();
  response.resolve({
    session: ui.session,
    capabilities: { text: true, voice: true, gmail: true },
  });
  await tick();
  await tick();
  assert.equal(ui.detachedUpdates, 0);
});
