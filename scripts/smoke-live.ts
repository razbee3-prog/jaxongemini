// Live end-to-end check against Gemini: token → connect → intake → start_workout tool call → tracker context → resume.
// Run: GEMINI_API_KEY=... npm run smoke:live
import { readFileSync } from "node:fs";
import { handleTokenRequest } from "../api/token";
import { LiveClient, type FunctionCall, type TokenInfo } from "../src/live/client";

const getToken = async () => {
  const r = await handleTokenRequest({ method: "POST", headers: {}, ip: "smoke" });
  if (r.status !== 200) throw new Error(`token: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as unknown as TokenInfo;
};

let out = "";
let audioBytes = 0;
let calls: FunctionCall[] = [];
let turnDone: () => void = () => {};
const turn = (ms = 40000) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting for turn")), ms);
    turnDone = () => { clearTimeout(t); res(); };
  });

const live = new LiveClient(getToken, {
  onAudio: (b) => (audioBytes += (b.length * 3) / 4),
  onOutputText: (t) => (out += t),
  onToolCall: (c) => { calls.push(...c); turnDone(); },
  onTurnComplete: () => turnDone(),
  onError: (e) => console.error("live error:", e),
});

async function say(text: string, ctx = false) {
  out = "";
  const p = turn();
  if (ctx) live.sendContext(text);
  live.sendText(text);
  await p;
  console.log(`> ${text}\n< ${out.trim() || "(no speech)"}${calls.length ? `  [tool: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args ?? {})})`).join(", ")}]` : ""}`);
}

await live.connect();
console.log("connected");
await say("[app] The user just opened Jax and is on camera. Greet them and start the intake.");
await say("I want to work on my legs. I have about 5 minutes, no injuries, and I weigh 80 kilos. Let's go, start the workout now.");
for (let i = 0; i < 3 && !calls.some((c) => c.name === "start_workout"); i++) await say("Yes, sounds good, start it.");
const start = calls.find((c) => c.name === "start_workout");
if (!start) throw new Error("no start_workout call");
calls = [];
out = "";
const p = turn();
live.sendToolResponse([{ id: start.id, name: start.name, response: { ok: true, first: { exercise: "Squats", target: 10 } } }]);
await p;
console.log(`< after tool: ${out.trim()}`);
const img = readFileSync(new URL("./fixtures/frame.jpg", import.meta.url)).toString("base64");
for (let i = 0; i < 3; i++) { live.sendVideo(img); await new Promise((r) => setTimeout(r, 1000)); }
live.sendContext("[tracker] Squats: rep 7/10");
await say("[tracker] Squats form flag: knees are caving inward at the bottom. 3 reps left.");
console.log(`audio ${Math.round(audioBytes / 1024)} KB, resumption handle ${live.handle ? "yes" : "no"}`);
if (!live.handle) throw new Error("no resumption handle");
// Simulate a dropped connection and resume the same session with a fresh token.
(live as unknown as { ws: WebSocket }).ws.close();
await new Promise((r) => setTimeout(r, 4000));
if (live.status !== "open") throw new Error(`did not resume: ${live.status}`);
await say("Quick question, what did I tell you I weigh?");
if (!/80|eighty/i.test(out)) throw new Error("resumed session lost context");
live.close();
console.log("SMOKE OK");
