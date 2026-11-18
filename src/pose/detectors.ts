import type { PoseFeatures } from "./features";

export interface Rep {
  t: number;
  /** Lowest value of the detector's signal (deg) seen during the rep. */
  minAngle: number;
  /** Features at the deepest point of the rep. */
  bottom: PoseFeatures;
  /** Largest torso tilt from vertical during the rep. */
  maxTilt: number;
  /** Largest hip sag (torso lengths) during the rep; negative = piked. */
  maxSag: number;
}

export interface RepDetector {
  state: string;
  /** Which camera view this detector needs to see the whole movement. */
  view: "front" | "side";
  update(f: PoseFeatures, tSec: number): Rep | null;
  reset(): void;
}

const MIN_REP_S = 0.6;

/** TOP → BOTTOM → TOP on an angle signal with hysteresis. */
class AngleDetector implements RepDetector {
  state = "WAIT";
  view: "front" | "side";
  private lastRepT = -Infinity;
  private minAngle = Infinity;
  private bottom: PoseFeatures | null = null;
  private maxTilt = 0;
  private maxSag = -Infinity;
  private signal: (f: PoseFeatures) => number;
  private downDeg: number;
  private upDeg: number;

  constructor(signal: (f: PoseFeatures) => number, downDeg: number, upDeg: number, view: "front" | "side" = "front") {
    this.signal = signal;
    this.downDeg = downDeg;
    this.upDeg = upDeg;
    this.view = view;
  }

  update(f: PoseFeatures, t: number): Rep | null {
    const a = this.signal(f);
    if (this.state === "WAIT") {
      if (a > this.upDeg) this.state = "UP";
      return null;
    }
    if (this.state === "UP") {
      if (a < this.downDeg) {
        this.state = "DOWN";
        this.minAngle = a;
        this.bottom = f;
        this.maxTilt = f.torsoTiltDeg;
        this.maxSag = f.hipSag;
      }
      return null;
    }
    if (a < this.minAngle) {
      this.minAngle = a;
      this.bottom = f;
    }
    this.maxTilt = Math.max(this.maxTilt, f.torsoTiltDeg);
    this.maxSag = Math.max(this.maxSag, f.hipSag);
    if (a > this.upDeg) {
      this.state = "UP";
      if (t - this.lastRepT < MIN_REP_S || !this.bottom) return null;
      this.lastRepT = t;
      return { t, minAngle: this.minAngle, bottom: this.bottom, maxTilt: this.maxTilt, maxSag: this.maxSag };
    }
    return null;
  }

  reset() {
    this.state = "WAIT";
    this.lastRepT = -Infinity;
  }
}

/** Squat: average knee angle enters DOWN under 135° so shallow reps count and can be flagged (> 110° = too shallow). */
export const SQUAT_DOWN_DEG = 135;
export const SQUAT_UP_DEG = 160;
export const squatDetector = () => new AngleDetector((f) => f.kneeAvg, SQUAT_DOWN_DEG, SQUAT_UP_DEG);

/** Lunge: the front (most bent) knee crosses below 105° and returns above 155°. */
export const lungeDetector = () => new AngleDetector((f) => f.kneeMin, 105, 155);

/** Push-up (side view): elbow below 115° then back above 150°; depth is flagged when it never gets under 100°. */
export const PUSHUP_DOWN_DEG = 115;
export const PUSHUP_UP_DEG = 150;
export const pushupDetector = () => new AngleDetector((f) => f.elbow, PUSHUP_DOWN_DEG, PUSHUP_UP_DEG, "side");

/** Glute bridge (side view): shoulder-hip-knee angle opens above 160° (top) from below 135° (floor). Signal is inverted so TOP is the counted peak. */
export const bridgeDetector = () => new AngleDetector((f) => 360 - f.hip, 360 - 160, 360 - 135, "side");

/** Jumping jacks: wrists above shoulders AND ankles > 1.5× hip width, then back. */
class JackDetector implements RepDetector {
  state = "WAIT";
  view = "front" as const;
  private lastRepT = -Infinity;
  private bottom: PoseFeatures | null = null;

  update(f: PoseFeatures, t: number): Rep | null {
    const open = f.wristsAboveShoulders && f.ankleDist > 1.5 * f.hipWidth;
    const closed = !f.wristsAboveShoulders && f.ankleDist < 1.2 * f.hipWidth;
    if (this.state === "WAIT" || this.state === "CLOSED") {
      if (closed) this.state = "CLOSED";
      if (this.state === "CLOSED" && open) {
        this.state = "OPEN";
        this.bottom = f;
      }
      return null;
    }
    if (closed) {
      this.state = "CLOSED";
      if (t - this.lastRepT < MIN_REP_S || !this.bottom) return null;
      this.lastRepT = t;
      return { t, minAngle: f.kneeAvg, bottom: this.bottom, maxTilt: f.torsoTiltDeg, maxSag: f.hipSag };
    }
    return null;
  }

  reset() {
    this.state = "WAIT";
    this.lastRepT = -Infinity;
  }
}

export const jackDetector = () => new JackDetector();

/** High knees: one rep per knee drive above hip-ish height (kneeLift > -0.15 torso) and back down. */
class KneeDriveDetector implements RepDetector {
  state = "WAIT";
  view = "front" as const;
  private lastRepT = -Infinity;

  update(f: PoseFeatures, t: number): Rep | null {
    const up = f.kneeLift > -0.15;
    const down = f.kneeLift < -0.45;
    if (this.state !== "UP") {
      if (down) this.state = "DOWN";
      if (this.state === "DOWN" && up) this.state = "UP";
      return null;
    }
    if (down) {
      this.state = "DOWN";
      if (t - this.lastRepT < 0.25) return null;
      this.lastRepT = t;
      return { t, minAngle: f.kneeMin, bottom: f, maxTilt: f.torsoTiltDeg, maxSag: f.hipSag };
    }
    return null;
  }

  reset() {
    this.state = "WAIT";
    this.lastRepT = -Infinity;
  }
}

export const kneeDriveDetector = () => new KneeDriveDetector();
