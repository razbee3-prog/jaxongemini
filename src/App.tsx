import { useEffect, useRef, useState } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { runTool } from "./jax/tools";
import { MicCapture, PcmPlayer } from "./live/audio";
import { LiveClient, type LiveStatus, type TokenInfo } from "./live/client";
import { FAULT_TEXT } from "./pose/formRules";
import type { Pt } from "./pose/oneEuro";
import { createLandmarker, PoseTracker } from "./pose/tracker";
import { CATALOG } from "./workout/catalog";
import { WorkoutSession, type SessionEvent, type Snapshot } from "./workout/session";

const EDGES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32],
];
const FRAME_MS = 1000;
const FRAME_W = 512;

function drawSkeleton(canvas: HTMLCanvasElement, pts: Pt[] | null, color: string) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!pts) return;
  const w = canvas.width, h = canvas.height;
  ctx.lineWidth = Math.max(3, w / 140);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const [a, b] of EDGES) {
    if (pts[a].v < 0.4 || pts[b].v < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(pts[a].x * w, pts[a].y * h);
    ctx.lineTo(pts[b].x * w, pts[b].y * h);
    ctx.stroke();
  }
}

/** Gemini's transcripts can include tags like <noise>; keep only the words. */
const clean = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What the pose tracker tells Jax. `context` messages are silent; the rest prompt Jax to speak. */
function trackerMessage(e: SessionEvent, s: WorkoutSession): { text: string; context?: boolean } | null {
  const name = s.current ? CATALOG[s.current.exercise].name : "";
  switch (e.type) {
    case "rep":
      return { text: `[tracker] ${name}: rep ${e.n}/${e.target}`, context: true };
    case "almost_done":
      return { text: `[tracker] ${name}: ${e.left} ${CATALOG[s.current!.exercise].mode === "reps" ? "reps" : "seconds"} left. Push them through it.` };
    case "form":
      return { text: `[tracker] ${name} form flag: ${FAULT_TEXT[e.fault]}. Give one short cue.` };
    case "form_fixed":
      return { text: `[tracker] ${name}: fixed — no longer seeing "${FAULT_TEXT[e.fault]}". Quick praise.` };
    case "out_of_frame":
      return { text: `[tracker] Can't see the user's whole body for ${name} (needs a ${e.view}-on view, head to feet). Ask them to adjust the phone or step back.` };
    case "set_complete": {
      const r = e.result;
      const faults = Object.entries(r.faults).map(([k, n]) => `${FAULT_TEXT[k as keyof typeof FAULT_TEXT]} (${n}x)`).join("; ");
      return { text: `[tracker] Set complete: ${r.name}, ${r.reps ? `${r.reps} reps in ` : ""}${r.seconds}s, ${r.kcal.toFixed(1)} kcal.${faults ? ` Form flags: ${faults}.` : ""} Praise, rest, then preview the next exercise.` };
    }
  }
}

export default function App() {
  const [stage, setStage] = useState<"start" | "live">("start");
  const [modelReady, setModelReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState(() => localStorage.getItem("jax-code") ?? "");
  const [status, setStatus] = useState<LiveStatus>("closed");
  const [jaxLine, setJaxLine] = useState("");
  const [youLine, setYouLine] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [summary, setSummary] = useState<ReturnType<WorkoutSession["summary"]> | null>(null);

  const camRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const liveRef = useRef<LiveClient | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const sessionRef = useRef(new WorkoutSession());
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    createLandmarker()
      .then(({ landmarker }) => {
        landmarkerRef.current = landmarker;
        setModelReady(true);
      })
      .catch((e) => setError(`Pose model failed to load: ${e}`));
    return () => stopRef.current();
  }, []);

  async function getToken(): Promise<TokenInfo> {
    const r = await fetch("/api/token", { method: "POST", headers: code ? { "x-jax-code": code } : {} });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) {
      setNeedCode(true);
      throw new Error("Enter the access code to start.");
    }
    if (!r.ok) throw new Error(body.error ?? `Token request failed (${r.status})`);
    return body as TokenInfo;
  }

  async function start() {
    setError(null);
    if (code) localStorage.setItem("jax-code", code);
    const player = new PcmPlayer();
    player.unlock();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      player.close();
      setError(`Jax needs your camera and microphone: ${e}`);
      return;
    }
    const cam = camRef.current!;
    cam.srcObject = stream;
    await cam.play();

    const session = sessionRef.current;
    let jaxText = "";
    let youText = "";
    const live = new LiveClient(getToken, {
      onAudio: (b) => {
        player.play(b);
        setSpeaking(true);
      },
      onInterrupted: () => player.interrupt(),
      onInputText: (t) => {
        youText += t;
        setYouLine(clean(youText));
      },
      onOutputText: (t) => {
        if (youText) youText = "";
        jaxText += t;
        setJaxLine(clean(jaxText));
      },
      onTurnComplete: () => {
        jaxText = "";
        youText = "";
      },
      onToolCall: (calls) => {
        const now = performance.now();
        live.sendToolResponse(calls.map((c) => ({ id: c.id, name: c.name, response: runTool(c, session, now) })));
        setSnap(session.snapshot(now));
        if (session.status === "done") setSummary(session.summary(now));
      },
      onStatus: setStatus,
      onError: (m) => setError(m),
    });
    liveRef.current = live;
    playerRef.current = player;
    try {
      await live.connect();
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      player.close();
      setError(String(e instanceof Error ? e.message : e));
      return;
    }

    const mic = new MicCapture();
    micRef.current = mic;
    await mic.start(stream, (b, rate) => live.sendAudio(b, rate));

    // ~1 fps JPEG frames so Jax can see form; pose tracking runs separately at camera rate.
    const frameCanvas = document.createElement("canvas");
    const frameTimer = setInterval(() => {
      if (!cam.videoWidth) return;
      frameCanvas.width = FRAME_W;
      frameCanvas.height = Math.round((cam.videoHeight / cam.videoWidth) * FRAME_W);
      frameCanvas.getContext("2d")!.drawImage(cam, 0, 0, frameCanvas.width, frameCanvas.height);
      const b64 = frameCanvas.toDataURL("image/jpeg", 0.7).split(",")[1];
      if (b64) live.sendVideo(b64);
    }, FRAME_MS);

    let wake: WakeLockSentinel | null = null;
    void navigator.wakeLock?.request("screen").then((w) => (wake = w)).catch(() => undefined);

    const tracker = new PoseTracker(landmarkerRef.current!);
    let running = true;
    let lastUi = 0;
    const emit = (events: SessionEvent[]) => {
      for (const e of events) {
        const m = trackerMessage(e, session);
        if (!m) continue;
        if (m.context) live.sendContext(m.text);
        else live.sendText(m.text);
      }
    };
    const loop = () => {
      if (!running) return;
      const now = performance.now();
      const frame = tracker.process(cam, now);
      if (frame) {
        emit(session.onPose(frame, now));
        const c = canvasRef.current;
        if (c) {
          if (c.width !== cam.videoWidth) {
            c.width = cam.videoWidth;
            c.height = cam.videoHeight;
          }
          const s = session.snapshot(now);
          drawSkeleton(c, frame.norm, s.status !== "active" ? "rgba(255,255,255,.5)" : !s.inFrame ? "#9ca3af" : s.lastFault ? "#f59e0b" : "#a3e635");
        }
      }
      emit(session.tick(now));
      if (now - lastUi > 100) {
        lastUi = now;
        setSnap(session.snapshot(now));
        setSpeaking(player.speaking);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    stopRef.current = () => {
      running = false;
      clearInterval(frameTimer);
      live.close();
      mic.stop();
      player.close();
      stream.getTracks().forEach((t) => t.stop());
      void wake?.release().catch(() => undefined);
    };
    setStage("live");
    live.sendText("[app] The user just opened Jax and is on camera. Greet them and start the intake.");
  }

  function stop() {
    stopRef.current();
    stopRef.current = () => {};
    setStatus("closed");
  }

  function toggleMute() {
    const mic = micRef.current;
    if (!mic) return;
    mic.muted = !mic.muted;
    setMuted(mic.muted);
  }

  function skip() {
    const live = liveRef.current;
    const s = sessionRef.current;
    if (!live || s.status === "intake" || s.status === "done") return;
    live.sendText("[app] The user tapped Next. Call next_exercise now and introduce the next exercise.");
  }

  function endWorkout() {
    const live = liveRef.current;
    if (!live) return;
    if (sessionRef.current.status === "intake") return stop();
    live.sendText("[app] The user tapped End. Call end_workout now and give a short recap.");
  }

  const s = snap;
  const active = s && (s.status === "active" || s.status === "rest");
  const left = s && s.mode === "time" ? Math.max(0, s.target - s.seconds) : 0;
  const progress = s && s.target ? Math.min(1, s.mode === "time" ? s.seconds / s.target : s.reps / s.target) : 0;

  return (
    <div className="app">
      <div className="cam">
        <video ref={camRef} playsInline muted autoPlay />
        <canvas ref={canvasRef} />
      </div>

      {stage === "start" && (
        <div className="start">
          <h1>JAX</h1>
          <p className="lead">Your AI personal trainer</p>
          <ul className="how">
            <li>Tell Jax what you want to work on</li>
            <li>Get live coaching on your form</li>
            <li>Reps and calories tracked for you</li>
          </ul>
          <p className="small">Prop your phone up so it can see your whole body. Jax uses your camera and mic.</p>
          {needCode && <input className="code" placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} />}
          <button className="go" disabled={!modelReady} onClick={start}>{modelReady ? "Start with Jax" : "Loading…"}</button>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {stage === "live" && (
        <>
          <div className="top">
            <div className="brand">
              <span className={`dot ${status} ${speaking ? "speaking" : ""}`} />
              JAX <span className="state">{status === "open" ? (speaking ? "speaking" : muted ? "muted" : "listening") : status}</span>
            </div>
            <div className="stats">
              <div><b>{Math.round(s?.kcal ?? 0)}</b> kcal</div>
              <div><b>{fmt(s?.elapsedS ?? 0)}</b></div>
            </div>
          </div>

          {active && s && (
            <div className={`card ${s.status}`}>
              <div className="row">
                <div>
                  <div className="ex">{s.name}</div>
                  <div className="sub">
                    {s.status === "rest" ? "Set done · rest" : `${s.index + 1} of ${s.plan.length}`}
                    {s.status === "active" && !s.inFrame && " · step into frame"}
                  </div>
                </div>
                <div className="count">
                  {s.mode === "time" ? fmt(left) : s.reps}
                  <span>{s.mode === "time" ? "left" : `/ ${s.target} reps`}</span>
                </div>
              </div>
              <div className="bar"><div style={{ width: `${progress * 100}%` }} /></div>
              <div className="plan">
                {s.plan.map((p, i) => (
                  <span key={i} className={i < s.index ? "done" : i === s.index ? "now" : ""}>{CATALOG[p.exercise].name}</span>
                ))}
              </div>
            </div>
          )}

          {summary && (
            <div className="summary">
              <h2>Workout done</h2>
              <div className="big">{summary.kcal} <span>kcal</span> · {summary.minutes} <span>min</span></div>
              <table>
                <tbody>
                  {summary.sets.map((r, i) => (
                    <tr key={i}><td>{r.name}</td><td>{r.reps ? `${r.reps} reps` : `${r.seconds}s`}</td><td>{r.kcal} kcal</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="small">Estimate: MET × weight ({summary.weightKg} kg) × time.</p>
            </div>
          )}

          <div className="captions">
            {youLine && <p className="you">{youLine}</p>}
            {jaxLine && <p className="jax">{jaxLine}</p>}
            {error && <p className="error">{error}</p>}
          </div>

          <div className="controls">
            <button onClick={toggleMute} className={muted ? "on" : ""}>{muted ? "Unmute" : "Mute"}</button>
            {active && <button onClick={skip}>Next</button>}
            {status !== "closed" ? <button className="end" onClick={summary ? stop : endWorkout}>{summary ? "Close" : "End"}</button> : <button onClick={() => location.reload()}>Restart</button>}
          </div>
        </>
      )}
    </div>
  );
}
