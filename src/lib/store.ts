import { blobReady, blobRead, blobWrite, blobExclusive } from "./blob-store";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createSession, refreshUntouchedWelcome, type Session } from "./domain";
import { compactHistory } from "./history";

const localDir = path.join(process.cwd(), ".data");
const queues = new Map<string, Promise<unknown>>();
export function storageReady() {
  return blobReady() || !process.env.VERCEL;
}
async function read<T>(key: string): Promise<T | null> {
  if (blobReady()) return blobRead<T>(key);
  if (process.env.VERCEL)
    throw new Error("Persistent storage is not configured.");
  try {
    return JSON.parse(
      await readFile(
        path.join(localDir, encodeURIComponent(key) + ".json"),
        "utf8",
      ),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function write(key: string, value: unknown) {
  if (blobReady()) {
    await blobWrite(key, value);
    return;
  }
  if (process.env.VERCEL)
    throw new Error("Persistent storage is not configured.");
  await mkdir(localDir, { recursive: true });
  const target = path.join(localDir, encodeURIComponent(key) + ".json");
  const temp = target + "." + randomUUID();
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, target);
}
export async function exclusive<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (blobReady()) return blobExclusive(key, fn);
  const previous = queues.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  queues.set(key, task);
  try {
    return await task;
  } finally {
    if (queues.get(key) === task) queues.delete(key);
  }
}
export async function getSession(id: string) {
  const session = await read<Session>("session:" + id);
  if (session) refreshUntouchedWelcome(session);
  return session;
}
export async function saveSession(s: Session) {
  compactHistory(s);
  s.revision++;
  await write("session:" + s.id, s);
}
export async function mutateSession<T>(
  id: string,
  fn: (s: Session) => Promise<T> | T,
) {
  return exclusive("session:" + id, async () => {
    const s = await getSession(id);
    if (!s) throw new Error("Session expired. Refresh to start again.");
    const result = await fn(s);
    await saveSession(s);
    return { session: s, result };
  });
}
export async function newSession(id: string) {
  const s = createSession(id);
  await saveSession(s);
  return s;
}
type Budget = { cents: number; reservations?: Record<string, number> };
export class BudgetLimitError extends Error {}
function budgetUnavailable(value: Budget) {
  return new BudgetLimitError(
    Object.values(value.reservations || {}).some((amount) => amount > 0)
      ? "The demo doesn’t have enough token budget available right now. Your conversation is saved."
      : "This demo has reached its token spending limit. Your conversation is saved.",
  );
}
// One active voice transport owns the available allowance. The threshold is
// derived from this exact hold, so it can keep talking beyond a fixed per-call
// cap without competing requests spending its shutdown headroom.
export async function reserveAvailableBudget(minimumCents: number) {
  if (!Number.isSafeInteger(minimumCents) || minimumCents <= 0)
    throw new Error("Invalid usage reservation.");
  return exclusive("budget", async () => {
    const limit = Number(process.env.DEMO_BUDGET_USD || 5) * 100;
    const value = (await read<Budget>("budget")) ?? { cents: 0 };
    if (
      !Number.isFinite(limit) ||
      limit < 0 ||
      !Number.isFinite(value.cents) ||
      value.cents < 0
    )
      throw new Error("The demo usage allowance needs configuration.");
    const reservedCents = Math.floor(Math.max(0, limit - value.cents));
    if (reservedCents < minimumCents) throw budgetUnavailable(value);
    const reservation = randomUUID();
    value.cents += reservedCents;
    value.reservations ??= {};
    value.reservations[reservation] = reservedCents;
    await write("budget", value);
    return { reservation, reservedCents };
  });
}
export async function reserveBudget(cents: number) {
  if (!Number.isFinite(cents) || cents <= 0)
    throw new Error("Invalid usage reservation.");
  return exclusive("budget", async () => {
    const limit = Number(process.env.DEMO_BUDGET_USD || 5) * 100;
    if (!Number.isFinite(limit) || limit < 0)
      throw new Error("The demo usage allowance needs configuration.");
    const value = (await read<Budget>("budget")) ?? { cents: 0 };
    if (value.cents + cents > limit) throw budgetUnavailable(value);
    const id = randomUUID();
    value.cents += cents;
    value.reservations ??= {};
    value.reservations[id] = cents;
    await write("budget", value);
    return id;
  });
}
export async function settleBudget(id: string, actualCents: number) {
  if (!Number.isFinite(actualCents) || actualCents < 0) return;
  await exclusive("budget", async () => {
    const value = await read<Budget>("budget");
    const reserved = value?.reservations?.[id];
    if (!value || reserved === undefined) return;
    value.cents = Math.max(0, value.cents - reserved + actualCents);
    delete value.reservations![id];
    await write("budget", value);
  });
}
export async function throttle(key: string, max: number, windowMs: number) {
  await exclusive("rate:" + key, async () => {
    const now = Date.now(),
      data = await read<{ count: number; until: number }>("rate:" + key);
    const next =
      !data || data.until < now
        ? { count: 1, until: now + windowMs }
        : { ...data, count: data.count + 1 };
    if (next.count > max)
      throw new Error("Give me a moment—please try again shortly.");
    await write("rate:" + key, next);
  });
}
export const rawStore = { read, write };
