import { buildSetup, DEFAULT_MODEL, DEFAULT_VOICE } from "../src/jax/setup";

export interface TokenRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}
export interface TokenResponse {
  status: number;
  body: Record<string, unknown>;
}

/** One connect plus reconnects (Gemini closes each connection after ~10 min). */
export const TOKEN_USES = 6;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const hits = new Map<string, number[]>();

export function rateLimited(ip: string, now = Date.now()): boolean {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
  return list.length > MAX_PER_WINDOW;
}

const header = (h: TokenRequest["headers"], name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Mint a short-lived Gemini Live ephemeral token so the API key never reaches the browser, plus Jax's session config.
 * The config is not locked into the token: session resumption is ignored on locked (constrained-setup) tokens,
 * and a few uses let the client reconnect and resume the same conversation when Gemini recycles the connection.
 */
export async function handleTokenRequest(req: TokenRequest, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { status: 500, body: { error: "GEMINI_API_KEY is not set on the server" } };
  if (rateLimited(req.ip)) return { status: 429, body: { error: "too many requests" } };
  const code = process.env.JAX_ACCESS_CODE;
  if (code && header(req.headers, "x-jax-code") !== code) return { status: 401, body: { error: "access code required" } };

  const model = process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
  const now = Date.now();
  const r = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      uses: TOKEN_USES,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
    }),
  });
  if (!r.ok) {
    console.error("auth_tokens failed", r.status, (await r.text()).slice(0, 500));
    return { status: 502, body: { error: "could not create a Gemini session token" } };
  }
  const { name } = (await r.json()) as { name?: string };
  if (!name) return { status: 502, body: { error: "no token returned" } };
  return { status: 200, body: { token: name, model, setup: buildSetup(model, process.env.JAX_VOICE || DEFAULT_VOICE) } };
}
