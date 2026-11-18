import react from "@vitejs/plugin-react";
import { cpSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/** Serve MediaPipe's wasm from our own origin. */
const copyWasm = (): Plugin => ({
  name: "copy-mediapipe-wasm",
  buildStart() {
    cpSync("node_modules/@mediapipe/tasks-vision/wasm", "public/mediapipe/wasm", { recursive: true });
  },
});

/** Run api/token.ts under `vite dev`, same as server/index.ts does in production. */
const devApi = (): Plugin => ({
  name: "dev-api-token",
  configureServer(server) {
    server.middlewares.use("/api/token", async (req, res) => {
      const mod = await server.ssrLoadModule("/api/token.ts");
      const out = await mod.handleTokenRequest({ method: req.method ?? "GET", headers: req.headers, ip: req.socket.remoteAddress ?? "" });
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(out.body));
    });
  },
});

export default defineConfig({
  plugins: [react(), copyWasm(), devApi()],
  server: { host: true, allowedHosts: [".trycloudflare.com"] },
});
