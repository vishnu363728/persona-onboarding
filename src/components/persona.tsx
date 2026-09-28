"use client";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  BatteryFull,
  Check,
  ChevronLeft,
  ChevronRight,
  Mail,
  MessageCircle,
  Mic,
  MicOff,
  Phone,
  Plus,
  Signal,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from "lucide-react";
import type { Message, PublicSession } from "@/lib/domain";
import { conversationDisplayMessages } from "@/lib/conversation-display";
import { useVoice } from "./use-voice";
import { MessageText } from "./message-text";
type Capabilities = { text: boolean; voice: boolean; gmail: boolean };
const uid = () => crypto.randomUUID();
const pendingNotice =
  "Your last message hasn’t been confirmed. You can retry it below.";
function trapFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled),a[href]",
    ),
  );
  const first = items[0],
    last = items.at(-1);
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first?.focus();
  }
}
function Avatar({
  name,
  size = "small",
}: {
  name: string;
  size?: "small" | "large" | "tiny";
}) {
  const official = name.trim().toLowerCase() === "persona";
  return (
    <div
      className={`avatar avatar-${size}${official ? " avatar-persona" : ""}`}
      aria-hidden="true"
    >
      {official ? (
        <Image
          src="/persona-mark.svg"
          width={64}
          height={64}
          alt=""
          unoptimized
          draggable={false}
        />
      ) : (
        <>
          <span>{(Array.from(name)[0] || "P").toUpperCase()}</span>
          <i />
          <b />
        </>
      )}
    </div>
  );
}
function GmailIcon() {
  return (
    <svg
      width="24"
      height="20"
      viewBox="0 0 24 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 18V4L12 11L22 4V18"
        stroke="#4285F4"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M2 4L12 11L22 4"
        stroke="#EA4335"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M22 7V18" stroke="#34A853" strokeWidth="4" />
      <path d="M2 7V18" stroke="#FBBC04" strokeWidth="4" />
    </svg>
  );
}
export default function Persona() {
  const [session, setSession] = useState<PublicSession | null>(null),
    [caps, setCaps] = useState<Capabilities>({
      text: false,
      voice: false,
      gmail: false,
    }),
    [draft, setDraft] = useState(""),
    [draftReady, setDraftReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [pending, setPending] = useState<{
      id: string;
      text?: string;
      resume?: boolean;
    } | null>(null),
    [drawer, setDrawer] = useState(false),
    [resetting, setResetting] = useState(false),
    [confirmReset, setConfirmReset] = useState(false),
    [callExpanded, setCallExpanded] = useState(true),
    [captions, setCaptions] = useState(true),
    [online, setOnline] = useState(true),
    [clock, setClock] = useState("9:41"),
    [notice, setNotice] = useState(""),
    [gmailOpening, setGmailOpening] = useState(false),
    [gmailAttempt, setGmailAttempt] = useState(0),
    [gmailFeedback, setGmailFeedback] = useState(""),
    [gmailRetry, setGmailRetry] = useState(false),
    [gmailReveal, setGmailReveal] = useState(0),
    [newMessages, setNewMessages] = useState(false),
    [workingActions, setWorkingActions] = useState<string[]>([]);
  const stage = useRef<HTMLElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    following = useRef(true),
    drawerTrigger = useRef<HTMLElement | null>(null),
    callButton = useRef<HTMLButtonElement>(null),
    gmailCardRef = useRef<HTMLDivElement>(null),
    gmailConnectButton = useRef<HTMLButtonElement>(null),
    gmailWindow = useRef<Window | null>(null),
    gmailVersion = useRef(0),
    gmailSessionCreatedAt = useRef<number | undefined>(undefined),
    gmailStartedStatus = useRef<PublicSession["gmail"]["status"]>("unknown"),
    gmailRevealRequested = useRef(false),
    scrollAnchor = useRef<{ id: string; top: number } | null>(null),
    displayedHistory = useRef<{ createdAt?: number; lastId?: string }>({}),
    input = useRef<HTMLTextAreaElement>(null),
    sending = useRef(false),
    resuming = useRef(false),
    generation = useRef(0),
    resetBusy = useRef(false),
    actions = useRef(new Map<string, Promise<boolean>>()),
    sendTask = useRef<{
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
    } | null>(null),
    resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    sendFailure = useRef<{ id: string; message: string } | null>(null),
    mounted = useRef(true);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const openDrawer = () => {
    drawerTrigger.current = document.activeElement as HTMLElement;
    setDrawer(true);
  };
  const closeDrawer = () => {
    setDrawer(false);
    setConfirmReset(false);
    requestAnimationFrame(() => drawerTrigger.current?.focus());
  };
  const minimizeCall = () => {
    setCallExpanded(false);
    requestAnimationFrame(() => callButton.current?.focus());
  };
  const revealGmail = () => {
    setDrawer(false);
    setConfirmReset(false);
    setCallExpanded(false);
    gmailRevealRequested.current = true;
    following.current = true;
    scrollAnchor.current = null;
    setNewMessages(false);
    setGmailReveal((value) => value + 1);
  };
  const scrollToLatest = useCallback(() => {
    const view = scroller.current;
    if (!view) return;
    view.scrollTo({
      top: view.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    following.current = true;
    setNewMessages(false);
  }, []);
  const acceptSession = useCallback((next: PublicSession) => {
    const view = scroller.current;
    if (view && !following.current) {
      const anchor = Array.from(
        view.querySelectorAll<HTMLElement>("[data-message-id]"),
      ).find(
        (el) =>
          el.offsetTop + el.offsetHeight > view.offsetTop + view.scrollTop,
      );
      if (anchor)
        scrollAnchor.current = {
          id: anchor.dataset.messageId!,
          top: anchor.offsetTop - view.offsetTop - view.scrollTop,
        };
    }
    setSession((old) =>
      !old ||
      next.createdAt > old.createdAt ||
      (next.createdAt === old.createdAt && next.revision >= old.revision)
        ? next
        : old,
    );
  }, []);
  const refresh = useCallback(async () => {
    const attempt = generation.current;
    const r = await fetch("/api/session", { cache: "no-store" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    if (attempt !== generation.current || !mounted.current)
      throw new DOMException("Conversation changed", "AbortError");
    acceptSession(d.session);
    setCaps(d.capabilities);
    return d.session as PublicSession;
  }, [acceptSession]);
  const send = useCallback(
    async (body: { id: string; text?: string; resume?: boolean }) => {
      if (sending.current || resetBusy.current) return;
      if (body.resume && pendingRef.current?.text) return;
      sending.current = true;
      const attempt = generation.current;
      following.current = true;
      setNewMessages(false);
      setBusy(true);
      if (!body.resume) setError("");
      setPending(body);
      const controller = new AbortController();
      const task = {
        controller,
        timer: setTimeout(() => controller.abort(), 55000),
      };
      sendTask.current = task;
      if (body.text) {
        try {
          localStorage.setItem("persona-pending", JSON.stringify(body));
        } catch {}
      }
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const d = await r.json();
        if (attempt !== generation.current || !mounted.current) return;
        if (r.status === 409 && d.retryable === false) {
          setPending(null);
          pendingRef.current = null;
          sendFailure.current = null;
          setDraft((current) => current || body.text || "");
          try {
            localStorage.removeItem("persona-pending");
          } catch {}
          setError(d.error);
          void refresh().catch(() => {});
          return;
        }
        if (!r.ok) throw new Error(d.error);
        acceptSession(d.session);
        setPending(null);
        if (body.text) {
          try {
            localStorage.removeItem("persona-pending");
          } catch {}
        }
      } catch (e) {
        if (attempt !== generation.current || !mounted.current) return;
        const message =
          e instanceof Error ? e.message : "Couldn’t send. Please try again.";
        sendFailure.current = { id: body.id, message };
        setError(message);
        void refresh().catch(() => {});
      } finally {
        clearTimeout(task.timer);
        if (sendTask.current === task) {
          sendTask.current = null;
          sending.current = false;
          if (mounted.current) setBusy(false);
        }
      }
    },
    [acceptSession, refresh],
  );
  const resume = useCallback(() => {
    if (resuming.current) return;
    resuming.current = true;
    const attempt = generation.current;
    resumeTimer.current = setTimeout(() => {
      resumeTimer.current = null;
      if (
        mounted.current &&
        attempt === generation.current &&
        !resetBusy.current
      )
        void send({ id: uid(), resume: true }).finally(() => {
          resuming.current = false;
        });
      else resuming.current = false;
    }, 650);
  }, [send]);
  const voice = useVoice({
    onSession: acceptSession,
    onEnded: () => {
      setCallExpanded(true);
      resume();
    },
    onError: setError,
  });
  const callRef = useRef(voice);
  callRef.current = voice;
  const name = session?.profile.agentName.value || "Persona",
    ringing = session?.call.status === "ringing" && voice.state === "idle";
  useEffect(() => {
    mounted.current = true;
    const params = new URLSearchParams(location.search);
    const gmailReturn = params.get("gmail");
    void refresh()
      .then((saved) => {
        if (!gmailReturn) return;
        if (!["connected", "cancelled"].includes(gmailReturn))
          setGmailRetry(true);
        setNotice(
          (gmailReturn === "connected" && saved.gmail.status === "connected") ||
            (gmailReturn === "cancelled" && saved.gmail.status === "deferred")
            ? ""
            : gmailReturn === "cancelled"
              ? "No problem—we can connect Gmail another time."
              : "Gmail couldn’t connect. You can try again.",
        );
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    try {
      setDraft(localStorage.getItem("persona-draft") || "");
      const saved = JSON.parse(
        localStorage.getItem("persona-pending") || "null",
      );
      if (
        typeof saved?.id === "string" &&
        saved.id.length >= 6 &&
        saved.id.length <= 100 &&
        typeof saved.text === "string" &&
        saved.text.trim() &&
        saved.text.length <= 2000
      ) {
        setPending({ id: saved.id, text: saved.text });
        setError(pendingNotice);
      }
    } catch {}
    setDraftReady(true);
    if (params.has("gmail")) {
      history.replaceState({}, "", location.pathname);
    }
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }),
      );
    tick();
    const t = setInterval(tick, 30000);
    return () => {
      mounted.current = false;
      gmailVersion.current++;
      gmailWindow.current = null;
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
      resuming.current = false;
      if (sendTask.current) {
        clearTimeout(sendTask.current.timer);
        sendTask.current.controller.abort();
        sendTask.current = null;
        sending.current = false;
      }
      clearInterval(t);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [refresh]);
  useEffect(() => {
    if (!draftReady) return;
    try {
      localStorage.setItem("persona-draft", draft);
    } catch {}
  }, [draft, draftReady]);
  useEffect(() => {
    if (
      pending?.text &&
      session?.messages.some((message) => message.id === "reply:" + pending.id)
    ) {
      setPending(null);
      const previousFailure = sendFailure.current;
      setError((previous) =>
        previous === pendingNotice ||
        (previousFailure?.id === pending.id &&
          previous === previousFailure.message)
          ? ""
          : previous,
      );
      sendFailure.current = null;
      try {
        localStorage.removeItem("persona-pending");
      } catch {}
    }
  }, [session, pending]);
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!view) return;
    const lastId = session?.messages.at(-1)?.id;
    const previous = displayedHistory.current;
    const changedConversation = previous.createdAt !== session?.createdAt;
    const received = !!lastId && lastId !== previous.lastId;
    displayedHistory.current = { createdAt: session?.createdAt, lastId };
    if (changedConversation) {
      following.current = true;
      scrollAnchor.current = null;
      setNewMessages(false);
    }
    if (!following.current && scrollAnchor.current) {
      const saved = scrollAnchor.current;
      const anchor = Array.from(
        view.querySelectorAll<HTMLElement>("[data-message-id]"),
      ).find((el) => el.dataset.messageId === saved.id);
      if (anchor)
        view.scrollTop = anchor.offsetTop - view.offsetTop - saved.top;
      else view.scrollTop = 0;
    }
    scrollAnchor.current = null;
    if (following.current) {
      const allMessages = view.querySelectorAll<HTMLElement>(".message-group");
      const lastMessage = allMessages.item(allMessages.length - 1);
      const target = gmailCardRef.current
        ? gmailCardRef.current.offsetTop - view.offsetTop - 12
        : !busy &&
            !error &&
            !notice &&
            lastMessage &&
            lastMessage.offsetHeight > view.clientHeight - 32
          ? lastMessage.offsetTop - view.offsetTop - 12
          : view.scrollHeight;
      view.scrollTo({
        top: target,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    } else if (received) setNewMessages(true);
  }, [
    session?.createdAt,
    session?.messages.length,
    session?.messages.at(-1)?.id,
    busy,
    pending,
    session?.gmail.status,
    gmailRetry,
    notice,
    error,
  ]);
  useLayoutEffect(() => {
    if (!gmailRevealRequested.current || drawer || !gmailCardRef.current)
      return;
    gmailRevealRequested.current = false;
    const view = scroller.current;
    if (view)
      view.scrollTo({
        top: gmailCardRef.current.offsetTop - view.offsetTop - 12,
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    gmailConnectButton.current?.focus({ preventScroll: true });
  }, [gmailReveal, session?.gmail.status, gmailRetry, drawer, callExpanded]);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height = `${Math.min(input.current.scrollHeight, 112)}px`;
  }, [draft]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      stage.current?.style.setProperty(
        "--viewport-height",
        `${viewport?.height || window.innerHeight}px`,
      );
      if (following.current) requestAnimationFrame(scrollToLatest);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
    };
  }, [scrollToLatest]);
  useEffect(() => {
    if (!session) return;
    const t = setInterval(
      () => {
        void refresh()
          .then((s) => {
            if (
              voice.state !== "idle" &&
              ["ended", "failed"].includes(s.call.status) &&
              callRef.current.ownsCall(s.call.id)
            )
              void callRef.current.end();
          })
          .catch(() => {});
      },
      voice.state === "idle" && !gmailOpening ? 45000 : 2500,
    );
    return () => clearInterval(t);
  }, [!!session, voice.state, gmailOpening, refresh]);
  useEffect(() => {
    if (!gmailOpening) return;
    const attempt = generation.current;
    const popupAttempt = gmailVersion.current;
    const popupSession = gmailSessionCreatedAt.current;
    const current = () =>
      mounted.current &&
      attempt === generation.current &&
      popupAttempt === gmailVersion.current;
    if (session?.createdAt !== popupSession) {
      gmailVersion.current++;
      gmailWindow.current = null;
      setGmailOpening(false);
      setGmailFeedback("");
      setGmailRetry(false);
      return;
    }
    if (
      session?.gmail.status === "connected" ||
      (session?.gmail.status === "deferred" &&
        gmailStartedStatus.current !== "deferred")
    ) {
      gmailVersion.current++;
      gmailWindow.current = null;
      setGmailOpening(false);
      setGmailFeedback("");
      setGmailRetry(false);
      return;
    }
    const update = () => {
      if (current()) void refresh().catch(() => {});
    };
    window.addEventListener("focus", update);
    const timer = setInterval(() => {
      if (!current()) return;
      if (!gmailWindow.current?.closed) return;
      gmailWindow.current = null;
      setGmailOpening(false);
      void refresh()
        .then((saved) => {
          if (!current() || saved.createdAt !== popupSession) return;
          if (["connected", "deferred"].includes(saved.gmail.status))
            setGmailRetry(false);
          setGmailFeedback(
            saved.gmail.status === "connected" ||
              saved.gmail.status === "deferred"
              ? ""
              : "The Google window closed. You can try again whenever you’re ready.",
          );
        })
        .catch(() => {
          if (current())
            setGmailFeedback(
              "We couldn’t check the connection. You can try again.",
            );
        });
    }, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [
    gmailOpening,
    gmailAttempt,
    session?.createdAt,
    session?.gmail.status,
    refresh,
  ]);
  const runAction = useCallback(
    (key: string, path: string, body?: unknown): Promise<boolean> => {
      if (resetBusy.current) return Promise.resolve(false);
      const existing = actions.current.get(key);
      if (existing) return existing;
      const attempt = generation.current;
      let task!: Promise<boolean>;
      task = (async () => {
        // Register the action before executing it, including synchronous fetch failures.
        await Promise.resolve();
        try {
          if (attempt !== generation.current || !mounted.current) return false;
          const r = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error);
          if (attempt !== generation.current || !mounted.current) return false;
          acceptSession(d.session);
          return true;
        } catch (e) {
          if (attempt !== generation.current || !mounted.current) return false;
          setError(e instanceof Error ? e.message : "Please try again.");
          return false;
        } finally {
          if (actions.current.get(key) === task) {
            actions.current.delete(key);
            if (mounted.current) setWorkingActions([...actions.current.keys()]);
          }
        }
      })();
      actions.current.set(key, task);
      setWorkingActions([...actions.current.keys()]);
      return task;
    },
    [acceptSession],
  );
  const event = useCallback(
    (type: string) =>
      runAction(
        ["decline", "missed"].includes(type) ? "call-response" : type,
        "/api/events",
        { event: type },
      ),
    [runAction],
  );
  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(
      () => {
        void event("missed").then((saved) => saved && resume());
      },
      Math.max(
        0,
        30000 - (Date.now() - (session?.call.startedAt || Date.now())),
      ),
    );
    return () => clearTimeout(t);
  }, [ringing, event, resume]);
  const beginCall = (direction: "incoming" | "outgoing") => {
    if (
      resetBusy.current ||
      voice.ending ||
      sending.current ||
      actions.current.has("call-response")
    )
      return;
    setError("");
    setDrawer(false);
    setCallExpanded(true);
    void voice.start(direction);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !draft.trim() ||
      busy ||
      pending ||
      !online ||
      !session ||
      resetting ||
      voice.state !== "idle" ||
      voice.ending
    )
      return;
    const text = draft.trim();
    setDraft("");
    void send({ id: uid(), text });
    input.current?.focus();
  };
  const startFresh = async () => {
    if (resetBusy.current) return;
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    resetBusy.current = true;
    generation.current++;
    if (sendTask.current) {
      clearTimeout(sendTask.current.timer);
      sendTask.current.controller.abort();
      sendTask.current = null;
    }
    sending.current = false;
    setBusy(false);
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
    resuming.current = false;
    actions.current.clear();
    setWorkingActions([]);
    gmailWindow.current = null;
    gmailVersion.current++;
    gmailRevealRequested.current = false;
    setGmailOpening(false);
    setGmailFeedback("");
    setGmailRetry(false);
    setResetting(true);
    try {
      if (voice.state !== "idle" || voice.ending) await voice.end(false);
      const r = await fetch("/api/reset", {
          method: "POST",
          signal: AbortSignal.timeout(15000),
        }),
        d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setSession(d.session);
      following.current = true;
      setNewMessages(false);
      setDraft("");
      setPending(null);
      sendFailure.current = null;
      try {
        localStorage.removeItem("persona-pending");
      } catch {}
      setError("");
      setNotice("");
      closeDrawer();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
      closeDrawer();
    } finally {
      resetBusy.current = false;
      setResetting(false);
    }
  };
  const connectGmail = () => {
    if (resetBusy.current || voice.ending || !caps.gmail) return;
    if (gmailWindow.current && !gmailWindow.current.closed) {
      gmailWindow.current.focus();
      return;
    }
    try {
      localStorage.setItem("persona-draft", draft);
    } catch {}
    if (voice.state !== "idle") {
      // Open synchronously from the click so a live call survives Google consent.
      const popup = window.open(
        "about:blank",
        "_blank",
        "popup,width=520,height=720",
      );
      if (!popup) {
        setGmailFeedback(
          "Your browser blocked the Google window. Allow pop-ups for this page and try again, or connect after our call.",
        );
        return;
      }
      try {
        popup.opener = null;
        popup.location.href = "/api/google/start?popup=1";
        gmailWindow.current = popup;
        gmailSessionCreatedAt.current = session?.createdAt;
        setGmailAttempt(++gmailVersion.current);
        gmailStartedStatus.current = session?.gmail.status || "unknown";
        setGmailOpening(true);
        setGmailFeedback("");
      } catch {
        // This is our newly created blank window, never an existing user tab.
        popup.close();
        setGmailFeedback(
          "Google couldn’t open. Try again, or connect after our call.",
        );
      }
      return;
    }
    location.href = "/api/google/start";
  };
  const gmailCard = () => (
    <div className="gmail-card" ref={gmailCardRef}>
      <div className="gmail-card-heading">
        <GmailIcon />
        <div>
          <strong>Connect Gmail</strong>
          <span>Whenever you’re ready.</span>
        </div>
      </div>
      <p>
        {caps.gmail
          ? "Google asks for read-only Gmail access. This demo only checks your address; it doesn’t read or send messages."
          : "Gmail isn’t available just yet. We can keep talking here."}
      </p>
      <div className="gmail-actions">
        <button
          onClick={connectGmail}
          ref={gmailConnectButton}
          disabled={!caps.gmail || voice.ending || resetting}
          className="connect-button"
        >
          {gmailOpening ? "Return to Google" : "Connect Gmail"}{" "}
          <ChevronRight size={15} />
        </button>
        <button
          className="text-button"
          disabled={
            workingActions.includes("defer_gmail") || resetting || gmailOpening
          }
          onClick={() => {
            setGmailRetry(false);
            setGmailFeedback("");
            void event("defer_gmail");
          }}
        >
          Maybe later
        </button>
      </div>
      {(gmailOpening || gmailFeedback) && (
        <p className="gmail-feedback" role="status">
          {gmailOpening
            ? voice.state !== "idle"
              ? "Google is open in another window. Your call is still connected."
              : "Google is open in another window. Come back here when you’re done."
            : gmailFeedback}
        </p>
      )}
    </div>
  );
  const messages = conversationDisplayMessages(session?.messages || []).filter(
    (message) => message.role === "event" || message.channel !== "voice",
  );
  const lastUserId = pending?.text
    ? pending.id
    : messages.findLast((m) => m.role === "user")?.id;
  const optimistic =
    pending?.text && !messages.some((m) => m.id === pending.id)
      ? ({
          id: pending.id,
          role: "user",
          text: pending.text,
          channel: "text",
          at: Date.now(),
        } as Message)
      : null;
  return (
    <main className="stage" ref={stage}>
      <section className="device-area" aria-label="Your personal AI">
        <div className="phone-shell">
          <div
            className={`phone-screen ${voice.state !== "idle" && callExpanded ? "call-open" : ""}`}
          >
            <div className="status-bar" aria-hidden="true">
              <span>{clock}</span>
              <div className="dynamic-island" />
              <div className="status-symbols">
                <Signal size={15} fill="currentColor" />
                <Wifi size={15} />
                <BatteryFull size={22} />
              </div>
            </div>
            <header
              className="conversation-header"
              inert={drawer || (voice.state !== "idle" && callExpanded)}
            >
              <button
                className="back-button"
                onClick={openDrawer}
                disabled={!session}
                aria-label="Open your persona details"
              >
                <ChevronLeft size={29} />
                <span>1</span>
              </button>
              <button
                className="contact"
                onClick={openDrawer}
                disabled={!session}
                aria-label={`About ${name}`}
              >
                <Avatar name={name} />
                <span>
                  <span className="contact-name">{name}</span>
                  <ChevronRight size={12} />
                </span>
              </button>
              <button
                className="header-call"
                ref={callButton}
                onClick={() =>
                  voice.state === "idle"
                    ? beginCall("outgoing")
                    : setCallExpanded(true)
                }
                aria-label={
                  voice.state === "idle"
                    ? `Call ${name}`
                    : `Return to call with ${name}`
                }
                disabled={
                  busy ||
                  resetting ||
                  voice.ending ||
                  workingActions.includes("call-response") ||
                  !session ||
                  !online
                }
              >
                <Phone size={24} />
              </button>
            </header>
            {voice.ending && (
              <div className="return-call" role="status">
                <Phone size={14} />
                Ending call…
              </div>
            )}
            {voice.state === "idle" &&
              !voice.ending &&
              session &&
              ["active", "connecting"].includes(session.call.status) && (
                <button
                  className="return-call"
                  inert={drawer}
                  disabled={
                    workingActions.includes("end-other-call") || resetting
                  }
                  onClick={() =>
                    void runAction("end-other-call", "/api/call/end", {
                      callId: session.call.id,
                    }).then((saved) => saved && resume())
                  }
                >
                  <Phone size={14} />A call is open in another tab
                  <span>
                    {workingActions.includes("end-other-call")
                      ? "Ending…"
                      : "End call"}
                  </span>
                </button>
              )}
            {voice.state !== "idle" && !callExpanded && (
              <button
                className="return-call"
                inert={drawer}
                onClick={() => setCallExpanded(true)}
              >
                <Phone size={14} />
                Tap to return to call{" "}
                <span>
                  {Math.floor(voice.seconds / 60)}:
                  {String(voice.seconds % 60).padStart(2, "0")}
                </span>
              </button>
            )}
            <div
              className="message-scroll"
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget;
                following.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 72;
                if (following.current) setNewMessages(false);
              }}
              inert={drawer || (voice.state !== "idle" && callExpanded)}
              role="log"
              aria-label="Conversation"
              aria-live="polite"
              aria-relevant="additions text"
            >
              <div className="conversation-date">
                {session
                  ? new Date(session.createdAt).toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })
                  : "Today"}
                <br />
                <span>iMessage</span>
              </div>
              {session && (
                <div className="intro-avatar">
                  <Avatar name={name} size="large" />
                  <p>
                    Persona
                    <br />
                    <span>Your personal AI</span>
                  </p>
                </div>
              )}
              {!!session?.historyTrimmed && (
                <p className="history-note">
                  Earlier messages are no longer shown. Your saved details are
                  kept.
                </p>
              )}
              {[...messages, ...(optimistic ? [optimistic] : [])].map((m) =>
                m.role === "event" ? (
                  <div
                    key={m.id}
                    className="system-message"
                    data-message-id={m.id}
                  >
                    {/gmail/i.test(m.text) ? (
                      <Mail size={12} />
                    ) : /call|audio/i.test(m.text) ? (
                      <Phone size={12} />
                    ) : (
                      <Check size={12} />
                    )}
                    {m.text}
                  </div>
                ) : (
                  <div
                    key={m.id}
                    className={`message-group ${m.role}`}
                    data-message-id={m.id}
                  >
                    <div className={`bubble ${m.role}`}>
                      {m.role === "assistant" ? (
                        <MessageText text={m.text} />
                      ) : (
                        m.text
                      )}
                    </div>
                    {m.role === "user" && m.id === lastUserId && (
                      <span
                        className={`message-meta ${pending?.id === m.id && !busy ? "unconfirmed" : ""}`}
                      >
                        {pending?.id === m.id
                          ? busy
                            ? "Sending…"
                            : "Not confirmed"
                          : "Delivered"}
                      </span>
                    )}
                  </div>
                ),
              )}
              {(session?.gmail.status === "offered" || gmailRetry) &&
                session?.gmail.status !== "connected" &&
                gmailCard()}
              {busy && (
                <div
                  className="bubble assistant typing"
                  aria-label={`${name} is typing`}
                  role="status"
                >
                  <i />
                  <i />
                  <i />
                </div>
              )}
              {!session && !error && (
                <div className="loading-state">
                  <span className="small-spinner" />
                  Starting your conversation…
                </div>
              )}
              {notice && (
                <div className="notice" role="status">
                  {notice}
                  <button
                    onClick={() => setNotice("")}
                    aria-label="Dismiss notification"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              {(!online || error) && (
                <div className="error-notice" role="alert">
                  <span>
                    {!online
                      ? "You’re offline. Your draft is safe—send it when you reconnect."
                      : error}
                  </span>
                  {online && (
                    <button
                      disabled={
                        busy ||
                        resetting ||
                        voice.ending ||
                        voice.state !== "idle"
                      }
                      onClick={() =>
                        pending
                          ? void send(pending)
                          : void refresh()
                              .then(() => setError(""))
                              .catch((e) => {
                                if (e.name !== "AbortError")
                                  setError(e.message);
                              })
                      }
                    >
                      {pending?.text ? "Retry message" : "Try again"}
                    </button>
                  )}
                </div>
              )}
            </div>
            {newMessages && (
              <button
                className="new-messages"
                onClick={scrollToLatest}
                inert={drawer || (voice.state !== "idle" && callExpanded)}
              >
                <ArrowDown size={13} />
                Latest messages
              </button>
            )}
            <div
              className="composer-area"
              inert={drawer || (voice.state !== "idle" && callExpanded)}
            >
              <form className="composer" onSubmit={submit}>
                <button
                  type="button"
                  className="plus-button"
                  aria-label="More options"
                  onClick={openDrawer}
                  disabled={!session}
                >
                  <Plus size={25} />
                </button>
                <div className="input-wrap">
                  <textarea
                    ref={input}
                    aria-label="Message"
                    placeholder={
                      voice.ending
                        ? "Ending call…"
                        : voice.state === "idle"
                          ? "iMessage"
                          : "You’re on a call"
                    }
                    value={draft}
                    maxLength={2000}
                    rows={1}
                    disabled={
                      voice.state !== "idle" ||
                      voice.ending ||
                      resetting ||
                      !session
                    }
                    enterKeyHint="send"
                    autoComplete="off"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing &&
                        e.keyCode !== 229
                      ) {
                        e.preventDefault();
                        submit(e);
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="send-button"
                    aria-label="Send message"
                    disabled={
                      !draft.trim() ||
                      busy ||
                      resetting ||
                      !!pending ||
                      voice.ending ||
                      !online ||
                      voice.state !== "idle" ||
                      !session
                    }
                  >
                    <ArrowUp size={21} strokeWidth={2.5} />
                  </button>
                </div>
              </form>
              <div className="home-indicator" />
            </div>
            {ringing && (
              <div
                className="incoming-banner"
                role="dialog"
                inert={drawer || resetting}
                aria-hidden={drawer || resetting || undefined}
                aria-label={`Incoming call from ${name}`}
              >
                <span className="visually-hidden" role="status">
                  Incoming call from {name}
                </span>
                <Avatar name={name} />
                <div className="incoming-info">
                  <span>PERSONA AUDIO</span>
                  <strong>{name}</strong>
                </div>
                <button
                  className="call-circle decline"
                  aria-label="Decline call"
                  disabled={
                    workingActions.includes("call-response") || resetting
                  }
                  onClick={() =>
                    void event("decline").then((saved) => saved && resume())
                  }
                >
                  <Phone size={22} className="hangup-icon" />
                </button>
                <button
                  className="call-circle accept"
                  aria-label="Accept call"
                  disabled={
                    busy ||
                    voice.ending ||
                    workingActions.includes("call-response") ||
                    resetting
                  }
                  onClick={() => beginCall("incoming")}
                >
                  <Phone size={22} fill="currentColor" />
                </button>
              </div>
            )}
            {voice.state !== "idle" && callExpanded && (
              <div
                className="call-screen"
                role="dialog"
                aria-label={`Audio call with ${name}`}
                aria-modal="true"
                onKeyDown={(e) => {
                  if (e.key === "Escape") minimizeCall();
                  trapFocus(e);
                }}
              >
                <button
                  className="minimize-call"
                  onClick={minimizeCall}
                  aria-label="Return to messages"
                  autoFocus
                >
                  <ChevronLeft size={18} />
                  Messages
                </button>
                <div className="call-identity">
                  <span className="call-kind">PERSONA AUDIO</span>
                  <h2>{name}</h2>
                  <p>
                    {voice.state === "connecting"
                      ? "Calling…"
                      : `${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, "0")}`}
                  </p>
                </div>
                <div className={`call-orb ${voice.speaking ? "speaking" : ""}`}>
                  <Avatar name={name} size="large" />
                  <span />
                  <span />
                </div>
                <div className="call-caption" aria-live="off">
                  {captions ? (
                    voice.caption
                  ) : (
                    <span className="voice-bars">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <i key={i} style={{ animationDelay: `${i * 0.14}s` }} />
                      ))}
                    </span>
                  )}
                </div>
                {session?.gmail.status === "offered" && (
                  <button className="call-gmail" onClick={revealGmail}>
                    <Mail size={17} />
                    View Gmail connection
                    <ChevronRight size={15} />
                  </button>
                )}
                <div className="call-controls">
                  <div>
                    <button
                      onClick={voice.toggleMute}
                      className={voice.muted ? "selected" : ""}
                      aria-label={
                        voice.muted ? "Unmute microphone" : "Mute microphone"
                      }
                      aria-pressed={voice.muted}
                    >
                      {voice.muted ? <MicOff /> : <Mic />}
                    </button>
                    <span>{voice.muted ? "unmute" : "mute"}</span>
                  </div>
                  <div>
                    <button
                      onClick={voice.toggleQuiet}
                      className={!voice.quiet ? "selected" : ""}
                      aria-label={
                        voice.quiet ? "Turn sound on" : "Turn sound off"
                      }
                      aria-pressed={!voice.quiet}
                    >
                      {voice.quiet ? <VolumeX /> : <Volume2 />}
                    </button>
                    <span>speaker</span>
                  </div>
                  <div>
                    <button
                      onClick={() => setCaptions(!captions)}
                      className={captions ? "selected" : ""}
                      aria-label={captions ? "Hide captions" : "Show captions"}
                      aria-pressed={captions}
                    >
                      <MessageCircle />
                    </button>
                    <span>captions</span>
                  </div>
                </div>
                <div className="end-call">
                  <button
                    className="call-circle decline"
                    onClick={() => void voice.end()}
                    aria-label="End call"
                  >
                    <Phone size={28} className="hangup-icon" />
                  </button>
                  <span>end</span>
                </div>
                <div className="home-indicator" />
              </div>
            )}
            {drawer && (
              <div className="drawer-backdrop" onClick={closeDrawer}>
                <section
                  className="details-sheet"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="details-title"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      closeDrawer();
                    }
                    trapFocus(e);
                  }}
                >
                  <div className="sheet-handle" />
                  <button
                    className="close-sheet"
                    autoFocus
                    aria-label="Close details"
                    onClick={closeDrawer}
                  >
                    <X size={18} />
                  </button>
                  <Avatar name={name} size="large" />
                  <h2 id="details-title">{name}</h2>
                  <p className="sheet-subtitle">
                    Your personal AI, getting to know you.
                  </p>
                  <div className="memory-list">
                    <div>
                      <span>You</span>
                      <strong>
                        {session?.profile.userName.value ||
                          "Still getting acquainted"}
                      </strong>
                    </div>
                    <div>
                      <span>On your mind</span>
                      <strong>
                        {session?.profile.goal.value || "Whatever comes next"}
                      </strong>
                    </div>
                    <div>
                      <span>Gmail</span>
                      <strong>
                        {session?.gmail.status === "connected"
                          ? session.gmail.email
                          : "Not connected"}
                      </strong>
                    </div>
                  </div>
                  <p className="memory-hint">
                    Change your mind? Just tell me in the chat.
                    <br />
                    These details stay with this conversation.
                  </p>
                  {session?.gmail.status !== "connected" ? (
                    <button
                      className="sheet-action"
                      disabled={
                        workingActions.includes("show_gmail") || resetting
                      }
                      onClick={() => {
                        const attempt = generation.current;
                        revealGmail();
                        void event("show_gmail").then((saved) => {
                          if (!saved && attempt === generation.current)
                            gmailRevealRequested.current = false;
                        });
                      }}
                    >
                      <Mail size={18} />
                      Connect Gmail
                      <ChevronRight size={16} />
                    </button>
                  ) : (
                    <button
                      className="sheet-action"
                      disabled={
                        workingActions.includes("disconnect-gmail") || resetting
                      }
                      onClick={async () => {
                        const attempt = generation.current;
                        const saved = await runAction(
                          "disconnect-gmail",
                          "/api/google/disconnect",
                        );
                        if (!saved && attempt === generation.current)
                          closeDrawer();
                      }}
                    >
                      <Mail size={18} />
                      {workingActions.includes("disconnect-gmail")
                        ? "Disconnecting…"
                        : "Disconnect Gmail"}
                    </button>
                  )}
                  <button
                    className={`sheet-action reset-action ${confirmReset ? "confirm" : ""}`}
                    disabled={resetting}
                    onClick={() => void startFresh()}
                  >
                    <MessageCircle size={18} />
                    {resetting
                      ? "Starting a new conversation…"
                      : confirmReset
                        ? "Start fresh? This opens a new conversation."
                        : "New conversation"}
                    <ChevronRight size={16} />
                  </button>
                  <div className="sheet-privacy">
                    Saved for this browser for 7 days. AI can make mistakes.
                    <br />
                    <a href="/privacy" target="_blank" rel="noreferrer">
                      Privacy & this demo
                    </a>
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
