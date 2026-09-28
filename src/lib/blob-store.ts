import { get, put, del, list, BlobPreconditionFailedError } from "@vercel/blob";
import { randomUUID } from "node:crypto";
const root = "persona-v1/";
const pathname = (key: string) =>
  root +
  (key === "budget" ? "budget" : Buffer.from(key).toString("base64url")) +
  ".json";
const options = {
  access: "private" as const,
  addRandomSuffix: false,
  contentType: "application/json",
  cacheControlMaxAge: 60,
};
export const blobReady = () =>
  !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
export async function blobRead<T>(key: string): Promise<T | null> {
  const r = await get(pathname(key), { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return null;
  const value = await new Response(r.stream).json();
  if (value.expires && value.expires < Date.now()) return null;
  return value.data as T;
}
export async function blobWrite(key: string, data: unknown) {
  const expires = key === "budget" ? null : Date.now() + 7 * 86400000;
  await put(pathname(key), JSON.stringify({ data, expires }), {
    ...options,
    allowOverwrite: true,
  });
}
export async function blobExclusive<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const path = pathname("lock:" + key),
    token = randomUUID();
  let acquired: string | undefined;
  for (let i = 0; i < 90; i++) {
    const existing = await get(path, { access: "private", useCache: false });
    let etag: string | undefined;
    if (existing?.statusCode === 200) {
      const lock = await new Response(existing.stream).json();
      if (lock.expires > Date.now()) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      etag = existing.blob.etag;
    }
    try {
      const result = await put(
        path,
        JSON.stringify({ token, expires: Date.now() + 90000 }),
        {
          ...options,
          allowOverwrite: !!etag,
          ...(etag ? { ifMatch: etag } : {}),
        },
      );
      acquired = result.etag;
      break;
    } catch (e) {
      if (
        !(e instanceof BlobPreconditionFailedError) &&
        !(
          e instanceof Error &&
          /already exists|conflict|precondition/i.test(e.message)
        )
      )
        throw e;
    }
  }
  if (!acquired)
    throw new Error(
      "A previous request is still finishing. Try again in a moment.",
    );
  try {
    return await fn();
  } finally {
    await del(path, { ifMatch: acquired }).catch((e) => {
      if (!(e instanceof BlobPreconditionFailedError))
        console.error("Lock release failed");
    });
  }
}
export async function cleanupBlobs() {
  let cursor: string | undefined,
    count = 0;
  do {
    const page = await list({ prefix: root, limit: 100, cursor });
    for (const item of page.blobs) {
      if (item.uploadedAt.getTime() > Date.now() - 7 * 86400000) continue;
      if (item.pathname === pathname("budget")) continue;
      const r = await get(item.url, { access: "private", useCache: false });
      if (r?.statusCode !== 200) continue;
      const value = await new Response(r.stream).json();
      if (value.expires && value.expires < Date.now()) {
        await del(item.url, { ifMatch: r.blob.etag }).catch(() => {});
        count++;
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return count;
}
