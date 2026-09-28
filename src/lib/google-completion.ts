import { randomBytes } from "node:crypto";
export type GoogleCompletion =
  "connected" | "cancelled" | "unavailable" | "error";

export function googleCompletionResponse(
  origin: string,
  result: GoogleCompletion,
  popup: boolean,
) {
  if (!popup) return Response.redirect(origin + "/?gmail=" + result, 303);
  const copy = {
    connected: {
      title: "Gmail connected",
      detail: "You can close this window and return to your conversation.",
    },
    cancelled: {
      title: "No problem",
      detail:
        "Gmail connection was cancelled. You can close this window and keep talking.",
    },
    unavailable: {
      title: "Gmail isn’t available yet",
      detail:
        "You can close this window and continue your conversation without connecting.",
    },
    error: {
      title: "Gmail couldn’t connect",
      detail:
        "You can close this window and return to your conversation to try again.",
    },
  }[result];
  const nonce = randomBytes(16).toString("base64url");
  // All displayed strings are fixed application copy. Never interpolate OAuth
  // query parameters, tokens, provider errors, addresses or redirect targets.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title><style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#f8f8f5;color:#171717;font:16px/1.55 system-ui,-apple-system,sans-serif}main{max-width:340px;padding:36px;text-align:center}h1{font-size:25px;letter-spacing:-.6px;line-height:1.2}p{color:#5b5b59}button{margin-top:16px;border:0;border-radius:999px;padding:13px 24px;background:#171717;color:white;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #007aff;outline-offset:4px}</style></head><body><main><h1>${copy.title}</h1><p>${copy.detail}</p><button id="close" type="button">Close window</button></main><script nonce="${nonce}">history.replaceState(null, "", location.pathname);document.getElementById("close").addEventListener("click", function(){window.close();});</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
