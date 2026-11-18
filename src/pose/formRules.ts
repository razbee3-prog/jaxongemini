import type { Rep } from "./detectors";
import type { PoseFeatures } from "./features";

export type Fault =
  | "knees_caving"
  | "squat_depth"
  | "uneven_hips"
  | "torso_lean"
  | "hips_sagging"
  | "hips_piked"
  | "pushup_depth"
  | "bridge_height";

/** Highest priority first (safety before depth before polish). */
export const FAULT_PRIORITY: Fault[] = ["hips_sagging", "knees_caving", "torso_lean", "hips_piked", "squat_depth", "pushup_depth", "bridge_height", "uneven_hips"];

/** Plain-language description handed to Jax, who phrases the actual cue. */
export const FAULT_TEXT: Record<Fault, string> = {
  knees_caving: "knees are caving inward at the bottom",
  squat_depth: "squats are shallow (thighs well above parallel)",
  uneven_hips: "hips are uneven / shifting to one side",
  torso_lean: "torso is leaning forward a lot",
  hips_sagging: "hips are sagging below the shoulder-ankle line",
  hips_piked: "hips are piked up too high",
  pushup_depth: "push-ups are shallow (elbows not reaching ~90°)",
  bridge_height: "hips are not reaching full extension at the top",
};

export type RuleSet = (rep: Rep) => Fault[];
/** Checked continuously on timed holds (no reps). */
export type HoldRule = (f: PoseFeatures) => Fault[];

export const squatRules: RuleSet = (rep) => {
  const out: Fault[] = [];
  const b = rep.bottom;
  if (b.kneeDist < 0.8 * b.ankleDist) out.push("knees_caving");
  if (rep.minAngle > 110) out.push("squat_depth");
  if (b.hipDiff > 0.08 * b.torsoLen) out.push("uneven_hips");
  return out;
};

export const lungeRules: RuleSet = (rep) => (rep.maxTilt > 15 ? ["torso_lean"] : []);

export const pushupRules: RuleSet = (rep) => {
  const out: Fault[] = [];
  if (rep.maxSag > 0.18) out.push("hips_sagging");
  else if (rep.bottom.hipSag < -0.25) out.push("hips_piked");
  if (rep.minAngle > 100) out.push("pushup_depth");
  return out;
};

export const bridgeRules: RuleSet = (rep) => (360 - rep.minAngle < 170 ? ["bridge_height"] : []);

export const plankHold: HoldRule = (f) => (f.hipSag > 0.18 ? ["hips_sagging"] : f.hipSag < -0.25 ? ["hips_piked"] : []);
