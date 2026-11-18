import type { RepDetector } from "../pose/detectors";
import type { PoseFeatures } from "../pose/features";
import { FAULT_PRIORITY, type Fault, type HoldRule, type RuleSet } from "../pose/formRules";
import { CATALOG, DEFAULT_WEIGHT_KG, kcalFor, type ExerciseId } from "./catalog";
import { TRACKING } from "./exercises";

export interface PlanItem {
  exercise: ExerciseId;
  /** Reps for "reps" exercises, seconds for "time" exercises. */
  target: number;
}

export interface SetResult {
  exercise: ExerciseId;
  name: string;
  target: number;
  reps: number;
  seconds: number;
  kcal: number;
  faults: Partial<Record<Fault, number>>;
}

export type SessionEvent =
  | { type: "rep"; n: number; target: number }
  | { type: "form"; fault: Fault }
  | { type: "form_fixed"; fault: Fault }
  | { type: "almost_done"; left: number }
  | { type: "set_complete"; result: SetResult }
  | { type: "out_of_frame"; view: "front" | "side" };

export type Status = "intake" | "active" | "rest" | "done";

export interface PoseInput {
  fullBody: boolean;
  sideBody: boolean;
  features: PoseFeatures | null;
}

export interface Snapshot {
  status: Status;
  focus: string;
  weightKg: number;
  index: number;
  plan: PlanItem[];
  current: PlanItem | null;
  name: string;
  mode: "reps" | "time" | null;
  reps: number;
  seconds: number;
  target: number;
  kcal: number;
  elapsedS: number;
  history: SetResult[];
  inFrame: boolean;
  lastFault: Fault | null;
}

const CUE_GAP_MS = 12_000;
const OUT_OF_FRAME_MS = 3_000;
const OUT_OF_FRAME_GAP_MS = 15_000;

export class WorkoutSession {
  status: Status = "intake";
  focus = "";
  weightKg = DEFAULT_WEIGHT_KG;
  plan: PlanItem[] = [];
  index = -1;
  history: SetResult[] = [];
  private startMs = 0;
  private endMs = 0;
  private setStartMs = 0;
  private setEndMs = 0;
  private reps = 0;
  private faults: Partial<Record<Fault, number>> = {};
  private detector: RepDetector | null = null;
  private rules: RuleSet | undefined;
  private hold: HoldRule | undefined;
  private recent: Fault[][] = [];
  private holdWindow: { t: number; faults: Fault[] }[] = [];
  private lastCueMs = -Infinity;
  private cued: Fault | null = null;
  private cleanSinceCue = 0;
  private lastSeenMs = 0;
  private lastOutMs = -Infinity;
  private inFrame = false;
  private almostSent = false;

  start(plan: PlanItem[], weightKg: number | undefined, focus: string, nowMs: number) {
    this.plan = plan;
    this.focus = focus;
    if (weightKg && weightKg > 25 && weightKg < 300) this.weightKg = weightKg;
    this.history = [];
    this.startMs = nowMs;
    this.endMs = 0;
    this.index = -1;
    this.advance(nowMs);
  }

  get current(): PlanItem | null {
    return this.plan[this.index] ?? null;
  }

  private advance(nowMs: number) {
    this.index++;
    const item = this.current;
    if (!item) {
      this.finish(nowMs);
      return;
    }
    const t = TRACKING[item.exercise] ?? {};
    this.detector = t.detector?.() ?? null;
    this.rules = t.rules;
    this.hold = t.hold;
    this.reps = 0;
    this.faults = {};
    this.recent = [];
    this.holdWindow = [];
    this.cued = null;
    this.cleanSinceCue = 0;
    this.almostSent = false;
    this.lastSeenMs = nowMs;
    this.setStartMs = nowMs;
    this.setEndMs = 0;
    this.status = "active";
  }

  private finish(nowMs: number) {
    this.status = "done";
    this.endMs = nowMs;
    this.detector = null;
  }

  private setSeconds(nowMs: number) {
    if (!this.current || this.status === "intake") return 0;
    return ((this.setEndMs || nowMs) - this.setStartMs) / 1000;
  }

  private result(nowMs: number): SetResult {
    const item = this.current!;
    const seconds = this.setSeconds(nowMs);
    return {
      exercise: item.exercise,
      name: CATALOG[item.exercise].name,
      target: item.target,
      reps: this.reps,
      seconds: Math.round(seconds),
      kcal: kcalFor(CATALOG[item.exercise].met, this.weightKg, seconds),
      faults: { ...this.faults },
    };
  }

  private completeSet(nowMs: number): SessionEvent {
    this.setEndMs = nowMs;
    this.status = "rest";
    return { type: "set_complete", result: this.result(nowMs) };
  }

  /** Feed one pose frame. Returns events for Jax / the UI. */
  onPose(frame: PoseInput, nowMs: number): SessionEvent[] {
    if (this.status !== "active" || !this.current) return [];
    const out: SessionEvent[] = [];
    const entry = CATALOG[this.current.exercise];
    const seen = entry.view === "front" ? frame.fullBody : frame.sideBody;
    this.inFrame = seen;
    if (seen) this.lastSeenMs = nowMs;
    else if (nowMs - this.lastSeenMs > OUT_OF_FRAME_MS && nowMs - this.lastOutMs > OUT_OF_FRAME_GAP_MS) {
      this.lastOutMs = nowMs;
      out.push({ type: "out_of_frame", view: entry.view });
    }
    const f = frame.features;
    if (!f || !seen) return out;

    if (this.detector) {
      const rep = this.detector.update(f, nowMs / 1000);
      if (rep) {
        this.reps++;
        const faults = this.rules?.(rep) ?? [];
        for (const k of faults) this.faults[k] = (this.faults[k] ?? 0) + 1;
        out.push({ type: "rep", n: this.reps, target: this.current.target }, ...this.cue(faults, nowMs));
        const left = this.current.target - this.reps;
        if (entry.mode === "reps") {
          if (left <= 0) out.push(this.completeSet(nowMs));
          else if (left <= 3 && !this.almostSent && this.current.target > 5) {
            this.almostSent = true;
            out.push({ type: "almost_done", left });
          }
        }
      }
    } else if (this.hold) {
      this.holdWindow.push({ t: nowMs, faults: this.hold(f) });
      while (this.holdWindow.length && nowMs - this.holdWindow[0].t > 3000) this.holdWindow.shift();
      if (this.holdWindow.length >= 10 && nowMs - this.holdWindow[0].t > 2500) {
        const counts = new Map<Fault, number>();
        for (const w of this.holdWindow) for (const k of w.faults) counts.set(k, (counts.get(k) ?? 0) + 1);
        const steady = [...counts].filter(([, n]) => n > 0.6 * this.holdWindow.length).map(([k]) => k);
        if (steady.length && nowMs - this.lastCueMs > CUE_GAP_MS) {
          const fault = FAULT_PRIORITY.find((k) => steady.includes(k))!;
          this.faults[fault] = (this.faults[fault] ?? 0) + 1;
          this.lastCueMs = nowMs;
          this.cued = fault;
          out.push({ type: "form", fault });
        }
      }
    }
    return out;
  }

  /** Gentle cue policy: a fault on 2 of the last 3 reps, at most one cue per 12 s; praise after 3 clean reps. */
  private cue(faults: Fault[], nowMs: number): SessionEvent[] {
    this.recent.push(faults);
    if (this.recent.length > 3) this.recent.shift();
    if (this.cued) {
      if (faults.includes(this.cued)) this.cleanSinceCue = 0;
      else if (++this.cleanSinceCue >= 3) {
        const fixed = this.cued;
        this.cued = null;
        return [{ type: "form_fixed", fault: fixed }];
      }
    }
    if (nowMs - this.lastCueMs < CUE_GAP_MS) return [];
    const fault = FAULT_PRIORITY.find((k) => this.recent.filter((r) => r.includes(k)).length >= 2);
    if (!fault) return [];
    this.lastCueMs = nowMs;
    this.cued = fault;
    this.cleanSinceCue = 0;
    return [{ type: "form", fault }];
  }

  /** Call every frame/timer tick: finishes timed sets. */
  tick(nowMs: number): SessionEvent[] {
    if (this.status !== "active" || !this.current) return [];
    if (CATALOG[this.current.exercise].mode === "time") {
      const left = this.current.target - this.setSeconds(nowMs);
      if (left <= 0) return [this.completeSet(nowMs)];
      if (left <= 5 && !this.almostSent && this.current.target > 10) {
        this.almostSent = true;
        return [{ type: "almost_done", left: Math.ceil(left) }];
      }
    }
    return [];
  }

  /** Finish the current set (if still running) and move to the next one. */
  next(nowMs: number): { finished: SetResult | null; next: PlanItem | null } {
    if (this.status === "intake" || this.status === "done") return { finished: null, next: null };
    if (!this.setEndMs) this.setEndMs = nowMs;
    const finished = this.result(nowMs);
    this.history.push(finished);
    this.advance(nowMs);
    return { finished, next: this.current };
  }

  end(nowMs: number) {
    if (this.status === "active" || this.status === "rest") this.next(nowMs);
    if (this.status !== "done") this.finish(nowMs);
    return this.summary(nowMs);
  }

  get totalKcal() {
    return this.history.reduce((s, r) => s + r.kcal, 0);
  }

  summary(nowMs: number) {
    const live = this.status === "active" || this.status === "rest" ? this.result(nowMs).kcal : 0;
    return {
      focus: this.focus,
      weightKg: this.weightKg,
      minutes: Math.round((((this.endMs || nowMs) - this.startMs) / 60000) * 10) / 10,
      kcal: Math.round(this.totalKcal + live),
      sets: this.history.map((r) => ({ ...r, kcal: Math.round(r.kcal * 10) / 10 })),
    };
  }

  snapshot(nowMs: number): Snapshot {
    const item = this.current;
    const entry = item ? CATALOG[item.exercise] : null;
    const live = this.status === "active" || this.status === "rest" ? this.result(nowMs).kcal : 0;
    return {
      status: this.status,
      focus: this.focus,
      weightKg: this.weightKg,
      index: this.index,
      plan: this.plan,
      current: item,
      name: entry?.name ?? "",
      mode: entry?.mode ?? null,
      reps: this.reps,
      seconds: this.setSeconds(nowMs),
      target: item?.target ?? 0,
      kcal: this.totalKcal + live,
      elapsedS: this.startMs ? ((this.endMs || nowMs) - this.startMs) / 1000 : 0,
      history: this.history,
      inFrame: this.inFrame,
      lastFault: this.cued,
    };
  }
}
