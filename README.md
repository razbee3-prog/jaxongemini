# Jax — AI personal trainer

Jax is a mobile web app that coaches you through a workout by voice, live:

1. **Personalized workout** — Jax asks what you want to work on, your time, injuries and weight, then builds a plan from its exercise catalog.
2. **Real-time form feedback** — your camera (~1 frame/s) and mic stream to **Gemini 3.8 Live**, which watches your form and talks you through it.
3. **Reps and calories** — on-device MediaPipe pose tracking counts reps, times holds and flags form faults; calories are estimated from MET × body weight × time.

## How it works

```
phone browser ──── mic PCM 16 kHz + JPEG frames 1 fps ────▶ Gemini 3.8 Live (WebSocket)
   │   ◀──────────── voice PCM 24 kHz + transcripts + tool calls ─┘
   │
   ├─ MediaPipe PoseLandmarker (on device) → rep detectors + form rules → "[tracker] …" messages to Jax
   └─ POST /api/token ──▶ server (holds GEMINI_API_KEY) ──▶ ephemeral token + session config
```

- **Key safety:** the server mints short-lived ephemeral tokens (`api/token.ts`); the API key never reaches the browser. Tokens expire after 30 min, must start a session within 60 s, and allow 6 uses so the client can reconnect.
- **Long sessions:** Gemini recycles connections; the client resumes the same conversation with session resumption handles and context-window compression (`src/live/client.ts`). Resumption does not work with tokens that lock the setup (`bidiGenerateContentSetup`), so the config is returned alongside the token instead.
- **Tools Jax calls:** `start_workout` (validated against the catalog), `next_exercise`, `end_workout` (`src/jax/setup.ts`, `src/jax/tools.ts`).
- **Pose tracking** (`src/pose`, `src/workout`) is adapted from strongr: front-view squats, lunges, jumping jacks, high knees; side-view push-ups, glute bridges, planks, mountain climbers.

## Run locally

Requires Node 22+.

```bash
npm install
export GEMINI_API_KEY=...      # never commit it
npm run dev                    # http://localhost:5173
```

The camera needs HTTPS on a phone. For a quick phone test: `cloudflared tunnel --url http://localhost:5173`.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | Server-side only; used to mint ephemeral tokens |
| `JAX_ACCESS_CODE` | no | If set, the app asks for this code before starting a session (protects your quota on a public URL) |
| `GEMINI_LIVE_MODEL` | no | Default `gemini-3.8-live` |
| `JAX_VOICE` | no | Prebuilt voice, default `Fenrir` |
| `TRUST_PROXY` | no | Set to `1` behind a reverse proxy so the rate limit uses `X-Forwarded-For` |

## Checks

```bash
npm run lint
npm run typecheck
npm test              # detectors, form cues, calories, session flow, tools, token route
npm run build
npm run smoke:live    # needs GEMINI_API_KEY: real Gemini session — intake, start_workout call, tracker cue, reconnect + resume
```

## Production

```bash
npm run build
npx esbuild server/index.ts --bundle --platform=node --format=esm --target=node22 --outfile=server.mjs
GEMINI_API_KEY=... node server.mjs   # serves dist/ and /api/token on $PORT (3000)
```

Or `docker build -t jax . && docker run -e GEMINI_API_KEY=... -p 3000:3000 jax`.

Calorie numbers are estimates (ACSM MET formula), not measurements.
