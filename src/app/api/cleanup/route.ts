import { cleanupBlobs, blobReady } from "@/lib/blob-store";
export const maxDuration = 60;
export async function GET(req: Request) {
  if (
    !process.env.CRON_SECRET ||
    req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  )
    return new Response("Unauthorized", { status: 401 });
  return Response.json({ removed: blobReady() ? await cleanupBlobs() : 0 });
}
