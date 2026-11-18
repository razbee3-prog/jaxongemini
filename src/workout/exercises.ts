import { bridgeDetector, jackDetector, kneeDriveDetector, lungeDetector, pushupDetector, squatDetector, type RepDetector } from "../pose/detectors";
import { bridgeRules, lungeRules, plankHold, pushupRules, squatRules, type HoldRule, type RuleSet } from "../pose/formRules";
import type { ExerciseId } from "./catalog";

export interface Tracking {
  detector?: () => RepDetector;
  rules?: RuleSet;
  hold?: HoldRule;
}

export const TRACKING: Partial<Record<ExerciseId, Tracking>> = {
  squat: { detector: squatDetector, rules: squatRules },
  reverse_lunge: { detector: lungeDetector, rules: lungeRules },
  pushup: { detector: pushupDetector, rules: pushupRules },
  glute_bridge: { detector: bridgeDetector, rules: bridgeRules },
  jumping_jacks: { detector: jackDetector },
  high_knees: { detector: kneeDriveDetector },
  plank: { hold: plankHold },
  mountain_climbers: { hold: plankHold },
};
