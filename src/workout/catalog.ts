/** Exercise metadata shared by the browser and the token server (no browser-only imports). */

export type Focus = "legs" | "glutes" | "core" | "upper_body" | "cardio" | "full_body";

export interface CatalogEntry {
  name: string;
  focus: Focus[];
  /** MET from the Compendium of Physical Activities (approximate, bodyweight calisthenics). */
  met: number;
  /** "reps" sets are counted by the pose tracker; "time" sets are timed holds/intervals. */
  mode: "reps" | "time";
  /** Where the camera should see you from. */
  view: "front" | "side";
  defaultTarget: number;
  setup: string;
}

export const CATALOG = {
  squat: { name: "Squats", focus: ["legs", "glutes", "full_body"], met: 5.0, mode: "reps", view: "front", defaultTarget: 12, setup: "Face the camera, feet shoulder-width, whole body in frame." },
  reverse_lunge: { name: "Reverse Lunges", focus: ["legs", "glutes"], met: 4.0, mode: "reps", view: "front", defaultTarget: 10, setup: "Face the camera, whole body in frame; alternate legs." },
  pushup: { name: "Push-ups", focus: ["upper_body", "core", "full_body"], met: 3.8, mode: "reps", view: "side", defaultTarget: 10, setup: "Turn sideways to the camera so it sees you from head to feet; knees down is fine." },
  glute_bridge: { name: "Glute Bridges", focus: ["glutes", "core"], met: 3.5, mode: "reps", view: "side", defaultTarget: 12, setup: "Lie on your back, side-on to the camera, knees bent." },
  jumping_jacks: { name: "Jumping Jacks", focus: ["cardio", "full_body"], met: 7.7, mode: "reps", view: "front", defaultTarget: 25, setup: "Face the camera, whole body in frame, room to spread arms and legs." },
  high_knees: { name: "High Knees", focus: ["cardio", "legs"], met: 8.0, mode: "reps", view: "front", defaultTarget: 30, setup: "Face the camera, whole body in frame; each knee counts." },
  plank: { name: "Plank", focus: ["core", "full_body"], met: 3.8, mode: "time", view: "side", defaultTarget: 30, setup: "Forearm plank, side-on to the camera, head to heels in frame." },
  mountain_climbers: { name: "Mountain Climbers", focus: ["cardio", "core"], met: 8.0, mode: "time", view: "side", defaultTarget: 30, setup: "High plank, side-on to the camera; drive knees to chest." },
  march_in_place: { name: "March in Place", focus: ["cardio"], met: 3.5, mode: "time", view: "front", defaultTarget: 45, setup: "Warm-up: face the camera and march, swinging your arms." },
  stretch: { name: "Stretch", focus: ["full_body"], met: 2.3, mode: "time", view: "front", defaultTarget: 60, setup: "Cool-down: slow stretches, breathe." },
} as const satisfies Record<string, CatalogEntry>;

export type ExerciseId = keyof typeof CATALOG;
export const EXERCISE_IDS = Object.keys(CATALOG) as ExerciseId[];
export const isExerciseId = (x: unknown): x is ExerciseId => typeof x === "string" && x in CATALOG;

export const DEFAULT_WEIGHT_KG = 70;

/** kcal burned = MET × 3.5 × kg / 200 per minute (ACSM formula). */
export function kcalFor(met: number, weightKg: number, seconds: number): number {
  return (met * 3.5 * weightKg * (seconds / 60)) / 200;
}
