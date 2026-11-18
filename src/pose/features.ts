import type { Pt } from "./oneEuro";

export const LM = {
  nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
} as const;

const BODY = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip, LM.lKnee, LM.rKnee, LM.lAnkle, LM.rAnkle];

export interface PoseFeatures {
  /** Both sides of the body (shoulders to ankles) are visible: front-on view. */
  fullBody: boolean;
  /** One whole side (shoulder, elbow, wrist, hip, knee, ankle) is visible: side-on view. */
  sideBody: boolean;
  kneeL: number;
  kneeR: number;
  kneeAvg: number;
  kneeMin: number;
  /** Elbow angle (shoulder-elbow-wrist) on the more visible side. */
  elbow: number;
  /** Shoulder-hip-knee angle on the more visible side (180 = straight). */
  hip: number;
  /** Shoulder-hip-ankle angle on the more visible side (180 = straight plank line). */
  bodyLine: number;
  /** Signed: + when the hips sit below the shoulder-ankle line (sagging), - when piked up. Torso lengths. */
  hipSag: number;
  kneeDist: number;
  ankleDist: number;
  hipWidth: number;
  hipDiff: number;
  torsoLen: number;
  torsoTiltDeg: number;
  /** Mean knee height lift vs hip (hip.y - knee.y), torso lengths; > 0 means a knee is above the hip. */
  kneeLift: number;
  wristsAboveShoulders: boolean;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function angleDeg(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

const SIDE_L = [LM.lShoulder, LM.lElbow, LM.lWrist, LM.lHip, LM.lKnee, LM.lAnkle];
const SIDE_R = [LM.rShoulder, LM.rElbow, LM.rWrist, LM.rHip, LM.rKnee, LM.rAnkle];
const visible = (raw: Pt[], idx: number[]) => idx.every((i) => raw[i].v > 0.5 && raw[i].x >= -0.02 && raw[i].x <= 1.02 && raw[i].y >= -0.02 && raw[i].y <= 1.02);

export function isFullBody(raw: Pt[] | null): boolean {
  if (!raw || raw.length < 33) return false;
  return BODY.every((i) => raw[i].v > 0.5 && raw[i].x >= 0 && raw[i].y >= 0 && raw[i].y <= 1.02);
}

export function isSideBody(raw: Pt[] | null): boolean {
  if (!raw || raw.length < 33) return false;
  return visible(raw, SIDE_L) || visible(raw, SIDE_R);
}

/** `p` must be in pixel space (aspect-correct) so angles are not distorted. */
export function computeFeatures(p: Pt[], fullBody: boolean, sideBody = fullBody): PoseFeatures {
  const kneeL = angleDeg(p[LM.lHip], p[LM.lKnee], p[LM.lAnkle]);
  const kneeR = angleDeg(p[LM.rHip], p[LM.rKnee], p[LM.rAnkle]);
  const midSh = { x: (p[LM.lShoulder].x + p[LM.rShoulder].x) / 2, y: (p[LM.lShoulder].y + p[LM.rShoulder].y) / 2, v: 1 };
  const midHip = { x: (p[LM.lHip].x + p[LM.rHip].x) / 2, y: (p[LM.lHip].y + p[LM.rHip].y) / 2, v: 1 };
  const torsoLen = dist(midSh, midHip) || 1;
  const tilt = (Math.atan2(Math.abs(midSh.x - midHip.x), Math.abs(midHip.y - midSh.y)) * 180) / Math.PI;
  const visL = SIDE_L.reduce((s, i) => s + p[i].v, 0);
  const visR = SIDE_R.reduce((s, i) => s + p[i].v, 0);
  const [sh, el, wr, hp, kn, an] = (visL >= visR ? SIDE_L : SIDE_R).map((i) => p[i]);
  // Distance of the hip from the shoulder-ankle line, positive when it is below the line (image y grows downward).
  const lx = an.x - sh.x, ly = an.y - sh.y;
  const len = Math.hypot(lx, ly) || 1;
  const cross = (lx * (hp.y - sh.y) - ly * (hp.x - sh.x)) / len;
  const hipSag = (lx >= 0 ? cross : -cross) / torsoLen;
  return {
    fullBody,
    sideBody,
    kneeL,
    kneeR,
    kneeAvg: (kneeL + kneeR) / 2,
    kneeMin: Math.min(kneeL, kneeR),
    elbow: angleDeg(sh, el, wr),
    hip: angleDeg(sh, hp, kn),
    bodyLine: angleDeg(sh, hp, an),
    hipSag,
    kneeDist: Math.abs(p[LM.lKnee].x - p[LM.rKnee].x),
    ankleDist: Math.abs(p[LM.lAnkle].x - p[LM.rAnkle].x),
    hipWidth: Math.abs(p[LM.lHip].x - p[LM.rHip].x) || 1,
    hipDiff: Math.abs(p[LM.lHip].y - p[LM.rHip].y),
    torsoLen,
    torsoTiltDeg: tilt,
    kneeLift: Math.max(midHip.y - p[LM.lKnee].y, midHip.y - p[LM.rKnee].y) / torsoLen,
    wristsAboveShoulders: p[LM.lWrist].y < p[LM.lShoulder].y && p[LM.rWrist].y < p[LM.rShoulder].y,
  };
}
