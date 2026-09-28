import React, { type ReactElement } from "react";
import Persona from "../src/components/persona";
import type { PublicSession } from "../src/lib/domain";

type Effect = {
  fn: () => void | (() => void);
  deps?: unknown[];
  cleanup?: () => void;
};
export type UIElement = ReactElement<Record<string, any>>;
export type UIRequest = {
  path: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
};
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function all(
  node: unknown,
  predicate: (element: UIElement) => boolean,
): UIElement[] {
  if (Array.isArray(node))
    return node.flatMap((child) => all(child, predicate));
  if (!node || typeof node !== "object" || !("type" in node)) return [];
  const element = node as UIElement;
  return [
    ...(predicate(element) ? [element] : []),
    ...all(element.props.children, predicate),
  ];
}
export const content = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(content).join("");
  return node && typeof node === "object" && "props" in node
    ? content((node as UIElement).props.children)
    : "";
};

// Render real Persona/useVoice hooks, commit effects separately, and model only
// the DOM measurements and platform APIs relevant to these interaction tests.
export function mountUI(
  options: {
    storage?: Map<string, string>;
    session?: PublicSession;
    scroll?: boolean;
    voice?: "idle" | "active";
    search?: string;
    popupBlocked?: boolean;
  } = {},
) {
  const storage = options.storage || new Map<string, string>();
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  const writes: string[] = [],
    requests: UIRequest[] = [];
  const api: Record<string, (request: UIRequest) => Promise<unknown>> = {};
  const timers = new Map<
    number,
    { fn: () => unknown; delay: number; interval: boolean }
  >();
  let timerId = 0,
    currentSession = options.session,
    focusCount = 0,
    focused = "",
    popupCount = 0,
    detached = false,
    detachedUpdates = 0,
    nodes: any[] = [];
  const popup = {
    closed: false,
    opener: {} as unknown,
    location: { href: "about:blank" },
    focusCount: 0,
    focus() {
      this.focusCount++;
    },
    close() {
      this.closed = true;
    },
  };
  const activeElement = {
    focus: () => {
      focusCount++;
    },
  };
  const document = { activeElement };
  const view = {
    offsetTop: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 150,
    querySelectorAll: () =>
      Object.assign([...nodes], {
        item: (index: number) => nodes[index] || null,
      }),
    scrollTo({ top }: { top: number }) {
      this.scrollTop = Math.min(
        Math.max(0, top),
        Math.max(0, this.scrollHeight - this.clientHeight),
      );
    },
  };
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), {
      innerHeight: 844,
      innerWidth: 390,
      open: () => {
        popupCount++;
        return options.popupBlocked ? null : popup;
      },
    }),
    document,
    location: {
      search: options.search || "",
      pathname: "/",
      origin: "https://fixture.test",
    },
    history: { replaceState() {} },
    navigator: { onLine: true },
    matchMedia: () => ({ matches: true }),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
        if (key === "persona-draft") writes.push(value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: async (
      path: string,
      init: { body?: string; signal?: AbortSignal } = {},
    ) => {
      const request = {
        path,
        body: JSON.parse(init.body || "{}"),
        signal: init.signal,
      };
      requests.push(request);
      if (!currentSession && !api[path]) return new Promise(() => {});
      const data = api[path]
        ? await api[path](request)
        : {
            session: structuredClone(currentSession),
            capabilities: { text: true, voice: true, gmail: true },
          };
      const status =
        (data as { responseStatus?: number }).responseStatus || 200;
      return { ok: status < 400, status, json: async () => data };
    },
    setTimeout: (fn: () => unknown, delay: number) => {
      const id = ++timerId;
      timers.set(id, { fn, delay, interval: false });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => unknown, delay: number) => {
      const id = ++timerId;
      timers.set(id, { fn, delay, interval: true });
      return id;
    },
    clearInterval: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
  })) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const hooks: unknown[] = [];
  let cursor = 0,
    effects: Effect[] = [],
    mountedEffects: Effect[] = [],
    tree: UIElement;
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a &&
    !!b &&
    a.length === b.length &&
    a.every((x, i) => Object.is(x, b[i]));
  function useEffect(fn: Effect["fn"], deps?: unknown[]) {
    const index = cursor++,
      old = hooks[index] as Effect | undefined;
    if (!old || !same(old.deps, deps)) {
      const next = { fn, deps, cleanup: old?.cleanup };
      hooks[index] = next;
      effects.push(next);
    }
  }
  function render() {
    if (tree)
      for (const element of all(tree, (el) => !!el.props.ref?.current))
        element.props.ref.current = null;
    cursor = 0;
    effects = [];
    const original = {
      useState: React.useState,
      useRef: React.useRef,
      useCallback: React.useCallback,
      useEffect: React.useEffect,
      useLayoutEffect: React.useLayoutEffect,
    };
    Object.assign(React, {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in hooks))
          hooks[index] =
            initial === "idle" ? options.voice || initial : initial;
        return [
          hooks[index],
          (value: unknown) => {
            if (detached) detachedUpdates++;
            hooks[index] =
              typeof value === "function"
                ? (value as (old: unknown) => unknown)(hooks[index])
                : value;
          },
        ];
      },
      useRef: (initial: unknown) => {
        const index = cursor++;
        return (hooks[index] ??= { current: initial });
      },
      useCallback: (fn: unknown, deps: unknown[]) => {
        const index = cursor++,
          old = hooks[index] as { fn: unknown; deps: unknown[] } | undefined;
        if (!old || !same(old.deps, deps)) hooks[index] = { fn, deps };
        return (hooks[index] as { fn: unknown }).fn;
      },
      useEffect,
      useLayoutEffect: useEffect,
    });
    try {
      tree = Persona();
    } finally {
      Object.assign(React, original);
    }
    for (const button of all(
      tree,
      (el) => el.type === "button" && !!el.props.ref,
    )) {
      const label =
        button.props["aria-label"] || content(button.props.children);
      button.props.ref.current = {
        focus: () => {
          focused = label;
          focusCount++;
        },
      };
    }
    if (options.scroll) {
      nodes = all(tree, (el) => !!el.props["data-message-id"]).map(
        (el, index) => ({
          dataset: { messageId: el.props["data-message-id"] },
          offsetTop: index * 100,
          offsetHeight: 100,
        }),
      );
      view.scrollHeight = nodes.length * 100;
      const card = all(tree, (el) => el.props.className === "gmail-card")[0];
      if (card) {
        card.props.ref.current = {
          offsetTop: view.scrollHeight,
          offsetHeight: 220,
        };
        view.scrollHeight += 220;
      }
      const log = all(tree, (el) => el.props.className === "message-scroll")[0];
      if (log) log.props.ref.current = view;
    }
    return tree;
  }
  function commit() {
    for (const effect of effects) {
      effect.cleanup?.();
      effect.cleanup = effect.fn() || undefined;
    }
    if (!mountedEffects.length) mountedEffects = [...effects];
  }
  return {
    render,
    commit,
    storage,
    writes,
    requests,
    api,
    view,
    popup,
    get popupCount() {
      return popupCount;
    },
    get focused() {
      return focused;
    },
    get detachedUpdates() {
      return detachedUpdates;
    },
    get tree() {
      return tree;
    },
    get focusCount() {
      return focusCount;
    },
    get session() {
      return currentSession;
    },
    set session(value) {
      currentSession = value;
    },
    find(predicate: (element: UIElement) => boolean) {
      return all(tree, predicate)[0];
    },
    button(label: string) {
      return all(
        tree,
        (el) =>
          el.type === "button" &&
          (el.props["aria-label"] === label ||
            content(el.props.children).trim() === label),
      )[0];
    },
    textarea() {
      return all(tree, (el) => el.type === "textarea")[0];
    },
    async flush() {
      for (let i = 0; i < 4; i++) {
        await tick();
        render();
        commit();
      }
      return tree;
    },
    runTimer(delay: number, interval = false) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay && timer.interval === interval) {
          if (!interval) timers.delete(id);
          timer.fn();
        }
      }
    },
    replayMount() {
      for (const effect of mountedEffects) effect.cleanup?.();
      for (const effect of mountedEffects)
        effect.cleanup = effect.fn() || undefined;
    },
    dispose() {
      for (const hook of hooks) (hook as Effect | undefined)?.cleanup?.();
      detached = true;
      for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
