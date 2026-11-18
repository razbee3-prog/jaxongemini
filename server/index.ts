import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { handleTokenRequest } from "../api/token";

const ROOT = join(process.cwd(), "dist");
const PORT = Number(process.env.PORT || 3000);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function clientIp(req: IncomingMessage) {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim() || req.socket.remoteAddress || "";
}

async function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname === "/api/token") {
    const out = await handleTokenRequest({ method: req.method || "GET", headers: req.headers, ip: clientIp(req) });
    res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out.body));
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(ROOT, path);
  let st = statSync(file, { throwIfNoEntry: false });
  if (!st || st.isDirectory()) {
    path = "/index.html";
    file = join(ROOT, path);
    st = statSync(file);
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    "content-length": st.size,
    "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : /^\/(models|mediapipe)\//.test(path) ? "public, max-age=86400" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  serve(req, res).catch((e) => {
    const bad = e instanceof URIError;
    if (!bad) console.error(e);
    if (!res.headersSent) res.writeHead(bad ? 400 : 500).end();
    else res.destroy();
  });
}).listen(PORT, () => console.log(`jax on :${PORT}`));
