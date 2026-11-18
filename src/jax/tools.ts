import { CATALOG, isExerciseId } from "../workout/catalog";
import type { PlanItem, WorkoutSession } from "../workout/session";
import type { FunctionCall } from "../live/client";

const describe = (p: PlanItem | null) =>
  p && { id: p.exercise, name: CATALOG[p.exercise].name, target: p.target, unit: CATALOG[p.exercise].mode === "reps" ? "reps" : "seconds", camera: CATALOG[p.exercise].view, setup: CATALOG[p.exercise].setup };

/** Runs one of Jax's tool calls against the workout session and returns the function response. */
export function runTool(call: FunctionCall, session: WorkoutSession, nowMs: number): Record<string, unknown> {
  const args = call.args ?? {};
  switch (call.name) {
    case "start_workout": {
      const raw = Array.isArray(args.exercises) ? (args.exercises as { id?: unknown; target?: unknown }[]) : [];
      const plan: PlanItem[] = raw
        .filter((e) => isExerciseId(e.id))
        .map((e) => {
          const id = e.id as PlanItem["exercise"];
          const t = Math.round(Number(e.target));
          return { exercise: id, target: t > 0 && t <= 600 ? t : CATALOG[id].defaultTarget };
        });
      if (!plan.length) return { ok: false, error: "No valid exercises. Use ids from the catalog." };
      session.start(plan, Number(args.weight_kg) || undefined, String(args.focus ?? ""), nowMs);
      return { ok: true, weight_kg: session.weightKg, plan: plan.map(describe), now_tracking: describe(session.current) };
    }
    case "next_exercise": {
      if (session.status === "intake") return { ok: false, error: "No workout yet; call start_workout first." };
      const { finished, next } = session.next(nowMs);
      return { ok: true, finished: finished && { ...finished, kcal: Math.round(finished.kcal * 10) / 10 }, next: describe(next), total_kcal: Math.round(session.totalKcal), workout_done: !next };
    }
    case "end_workout":
      return { ok: true, summary: session.end(nowMs) };
    default:
      return { ok: false, error: `Unknown tool ${call.name}` };
  }
}
