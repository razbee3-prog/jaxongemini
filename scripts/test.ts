// Offline checks: rep detectors on synthetic traces, cue policy, calories, session flow, tool handling, token route.
// Run: npm test
import assert from "node:assert/strict";
import { handleTokenRequest } from "../api/token";
import { runTool } from "../src/jax/tools";
import { buildSetup, TOOLS } from "../src/jax/setup";
import { jackDetector, pushupDetector, squatDetector, bridgeDetector, type RepDetector } from "../src/pose/detectors";
import type { PoseFeatures } from "../src/pose/features";
import { CATALOG, EXERCISE_IDS, kcalFor } from "../src/workout/catalog";
import { TRACKING } from "../src/workout/exercises";
import { WorkoutSession, type SessionEvent } from "../src/workout/session";

const base: PoseFeatures = {
  fullBody: true, sideBody: true, kneeL: 175, kneeR: 175, kneeAvg: 175, kneeMin: 175, elbow: 170, hip: 175, bodyLine: 178, hipSag: 0,
  kneeDist: 100, ankleDist: 100, hipWidth: 80, hipDiff: 2, torsoLen: 200, torsoTiltDeg: 3, kneeLift: -0.8, wristsAboveShoulders: false,
};
const FPS = 30;
let passed = 0;
const test = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve(fn()).then(() => { passed++; console.log(`ok - ${name}`); });

/** Sine dip from `top` to `bottom` per rep on the field(s) `set` writes. */
function trace(n: number, top: number, bottom: number, set: (a: number) => Partial<PoseFeatures>, repS = 2, noise = 2) {
  const frames: PoseFeatures[] = [];
  for (let i = 0; i < FPS; i++) frames.push({ ...base, ...set(top) });
  for (let r = 0; r < n; r++) {
    const k = Math.round(repS * FPS);
    for (let i = 0; i < k; i++) {
      const a = top - (top - bottom) * Math.sin((Math.PI * i) / k) + (Math.random() - 0.5) * 2 * noise;
      frames.push({ ...base, ...set(a) });
    }
  }
  return frames;
}
const count = (det: RepDetector, frames: PoseFeatures[]) => frames.reduce((c, f, i) => c + (det.update(f, i / FPS) ? 1 : 0), 0);
const knee = (a: number) => ({ kneeAvg: a, kneeL: a, kneeR: a, kneeMin: a });

await test("squat detector counts 12 deep and 12 fast squats", () => {
  assert.equal(count(squatDetector(), trace(12, 175, 85, knee)), 12);
  assert.equal(count(squatDetector(), trace(12, 175, 85, knee, 1.0)), 12);
});
await test("squat detector ignores jitter", () => assert.equal(count(squatDetector(), trace(10, 172, 165, knee, 2, 4)), 0));
await test("push-up detector counts elbow dips", () => assert.equal(count(pushupDetector(), trace(10, 170, 80, (a) => ({ elbow: a }))), 10));
await test("glute bridge detector counts hip extensions", () => {
  // Hip angle rises from 120 (floor) to 178 (top) and back.
  assert.equal(count(bridgeDetector(), trace(8, 120, 62, (a) => ({ hip: 240 - a }))), 8);
});
await test("jumping jack detector counts open/close cycles", () => {
  const frames: PoseFeatures[] = [];
  for (let r = 0; r < 15; r++) {
    for (let i = 0; i < 12; i++) frames.push({ ...base, ankleDist: 70, wristsAboveShoulders: false });
    for (let i = 0; i < 12; i++) frames.push({ ...base, ankleDist: 160, wristsAboveShoulders: true });
  }
  frames.push({ ...base, ankleDist: 70 });
  assert.equal(count(jackDetector(), frames), 15);
});

await test("calories use MET x 3.5 x kg / 200 per minute", () => {
  assert.equal(kcalFor(5, 80, 60), 7);
  assert.ok(Math.abs(kcalFor(8, 70, 30) - 4.9) < 1e-9);
});

await test("catalog, tracking and tool schema agree", () => {
  for (const id of Object.keys(TRACKING)) assert.ok(id in CATALOG, id);
  const start = TOOLS[0].functionDeclarations[0];
  assert.deepEqual(start.parameters!.properties.exercises.items.properties.id.enum, EXERCISE_IDS);
  const setup = buildSetup();
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.ok(!("sessionResumption" in setup));
});

function feed(s: WorkoutSession, frames: PoseFeatures[], t0: number) {
  const events: SessionEvent[] = [];
  frames.forEach((f, i) => {
    const t = t0 + (i * 1000) / FPS;
    events.push(...s.onPose({ fullBody: true, sideBody: true, features: f }, t), ...s.tick(t));
  });
  return { events, t: t0 + (frames.length * 1000) / FPS };
}

await test("session: shallow squats get spaced depth cues, set completes at target", () => {
  const s = new WorkoutSession();
  const r = runTool({ id: "1", name: "start_workout", args: { focus: "legs", weight_kg: 80, exercises: [{ id: "squat", target: 8 }, { id: "plank", target: 20 }, { id: "nope", target: 3 }] } }, s, 0);
  assert.equal(r.ok, true);
  assert.equal(s.plan.length, 2);
  const { events, t } = feed(s, trace(8, 175, 120, knee, 2.5), 0);
  const types = events.map((e) => e.type);
  assert.equal(types.filter((x) => x === "rep").length, 8);
  const cues = events.filter((e) => e.type === "form");
  assert.ok(cues.length >= 1 && cues.length <= 2, `cues: ${cues.length}`);
  assert.ok(cues.every((e) => e.type === "form" && e.fault === "squat_depth"));
  assert.ok(types.includes("almost_done"));
  assert.equal(types.at(-1), "set_complete");
  assert.equal(s.status, "rest");
  const nx = runTool({ id: "2", name: "next_exercise" }, s, t + 30_000);
  assert.equal((nx.next as { id: string }).id, "plank");
  assert.equal((nx.finished as { reps: number }).reps, 8);
  assert.equal(s.status, "active");
  // Timed plank finishes on its own after 20 s.
  const done = feed(s, Array(25 * FPS).fill(base), t + 30_000);
  assert.ok(done.events.some((e) => e.type === "set_complete"));
  const end = runTool({ id: "3", name: "end_workout" }, s, done.t);
  const summary = end.summary as { sets: unknown[]; kcal: number; weightKg: number };
  assert.equal(summary.sets.length, 2);
  assert.equal(summary.weightKg, 80);
  assert.ok(summary.kcal >= 1);
  assert.equal(s.status, "done");
});

await test("session: sagging plank triggers a hold cue, out-of-frame is reported", () => {
  const s = new WorkoutSession();
  s.start([{ exercise: "plank", target: 60 }], 70, "core", 0);
  const { events } = feed(s, Array(5 * FPS).fill({ ...base, hipSag: 0.3 }), 0);
  assert.deepEqual(events.filter((e) => e.type === "form").map((e) => e.type === "form" && e.fault), ["hips_sagging"]);
  const gone: SessionEvent[] = [];
  for (let i = 0; i < 5 * FPS; i++) gone.push(...s.onPose({ fullBody: false, sideBody: false, features: null }, 5000 + (i * 1000) / FPS));
  assert.deepEqual(gone.map((e) => e.type), ["out_of_frame"]);
});

await test("tools reject bad plans and calls before start", () => {
  const s = new WorkoutSession();
  assert.equal(runTool({ id: "1", name: "next_exercise" }, s, 0).ok, false);
  assert.equal(runTool({ id: "2", name: "start_workout", args: { focus: "x", exercises: [{ id: "burpee", target: 5 }] } }, s, 0).ok, false);
});

await test("token route: method, key, access code, rate limit, upstream", async () => {
  const req = { method: "POST", headers: {}, ip: "t1" };
  const ok = (async () => new Response(JSON.stringify({ name: "auth_tokens/abc" }), { status: 200 })) as typeof fetch;
  delete process.env.GEMINI_API_KEY;
  assert.equal((await handleTokenRequest({ ...req, method: "GET" }, ok)).status, 405);
  assert.equal((await handleTokenRequest(req, ok)).status, 500);
  process.env.GEMINI_API_KEY = "test";
  process.env.JAX_ACCESS_CODE = "letmein";
  assert.equal((await handleTokenRequest(req, ok)).status, 401);
  const good = await handleTokenRequest({ ...req, headers: { "x-jax-code": "letmein" } }, ok);
  assert.equal(good.status, 200);
  assert.equal(good.body.token, "auth_tokens/abc");
  assert.ok(good.body.setup);
  delete process.env.JAX_ACCESS_CODE;
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await handleTokenRequest({ ...req, ip: "t2" }, ok)).status;
  assert.equal(last, 429);
  const bad = (async () => new Response("nope", { status: 403 })) as typeof fetch;
  const orig = console.error;
  console.error = () => {};
  assert.equal((await handleTokenRequest({ ...req, ip: "t3" }, bad)).status, 502);
  console.error = orig;
});

console.log(`\n${passed} passed`);
