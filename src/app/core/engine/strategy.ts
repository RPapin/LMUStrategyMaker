import {
  CarSettings,
  PitStop,
  PlanResult,
  RaceSettings,
  Stint,
  StintAssignment,
  StrategyInputs,
  TyreChange,
  TyreCompound,
  Weather,
} from '../models';

/** Max number of DP states kept per stint (beam search). */
const BEAM = 1500;
const EPS = 1e-9;

export function weatherAt(race: RaceSettings, sec: number): Weather {
  const min = sec / 60;
  let w: Weather = 'dry';
  for (const win of race.weather) if (min >= win.fromMin && min < win.toMin) w = win.weather;
  return w;
}

const baseLap = (car: CarSettings, w: Weather) => (w === 'wet' ? car.lapTimeWetSec : car.lapTimeDrySec);
const vePerLap = (car: CarSettings, w: Weather) => (w === 'wet' ? car.vePerLapWet : car.vePerLapDry);
const tyreLife = (t: TyreCompound) => (t.wearPctPerLap > 0 ? Math.floor(100 / t.wearPctPerLap) : Infinity);

/** Tyres that can be used in the race: wet tyres are unlimited. */
export function tyreLimit(t: TyreCompound): number {
  return t.weather === 'wet' ? Infinity : t.tyres;
}

export function tyreChangeTime(race: RaceSettings, count: TyreChange): number {
  return count === 4 ? race.tyreChange4Sec : count === 2 ? race.tyreChange2Sec : 0;
}

export function serviceTime(race: RaceSettings, refuelSec: number, tyreSec: number, driverSec: number): number {
  return race.serviceParallel ? Math.max(refuelSec, tyreSec, driverSec) : refuelSec + tyreSec + driverSec;
}

export function makeStop(race: RaceSettings, refuelPct: number, tyreCount: TyreChange, driverChange: boolean): PitStop {
  const refuelSec = refuelPct * race.refuelSecPerPct;
  const tyreSec = tyreChangeTime(race, tyreCount);
  const driverSec = driverChange ? race.driverChangeSec : 0;
  const serviceSec = serviceTime(race, refuelSec, tyreSec, driverSec);
  return {
    laneSec: race.pitLaneLossSec,
    refuelPct,
    refuelSec,
    tyreCount,
    tyreSec,
    driverChange,
    driverSec,
    serviceSec,
    totalSec: race.pitLaneLossSec + serviceSec,
  };
}

interface DraftStint {
  laps: number;
  lapWeather: Weather[];
  veUsed: number;
}

interface TyreChoice {
  c: number;
  change: TyreChange;
}

interface Candidate {
  stints: DraftStint[];
  /** VE added at the stop before the first stint (re-plan only). */
  pre: number;
  fills: number[];
  choices: TyreChoice[];
  cost: number;
  lastLap: number;
}

/**
 * Tyres are tracked as two pairs (one side each). A 2-tyre change replaces the older pair,
 * so `ageOld >= ageNew` always holds.
 */
interface DPState {
  cost: number;
  c: number;
  ageOld: number;
  ageNew: number;
  used: number[];
  change: TyreChange;
  prev: DPState | null;
}

/** Where a re-plan starts: the car has just pitted in after the last locked stint. */
interface StartState {
  /** Index of the first stint to plan. */
  stint: number;
  lap: number;
  sec: number;
  ve: number;
  c: number;
  ageOld: number;
  ageNew: number;
  used: number[];
}

class Planner {
  private readonly race: RaceSettings;
  private readonly car: CarSettings;
  private readonly tyres: TyreCompound[];
  private readonly lives: number[];
  private readonly limits: number[];

  constructor(
    private readonly inp: StrategyInputs,
    private readonly start: StartState | null = null,
  ) {
    this.race = inp.race;
    this.car = inp.car;
    this.tyres = inp.tyres;
    this.lives = inp.tyres.map(tyreLife);
    this.limits = inp.tyres.map(tyreLimit);
  }

  private get j0(): number {
    return this.start?.stint ?? 0;
  }

  /** Lap time with the two pairs at the given ages: each pair accounts for half of the degradation. */
  lapCost(c: number, ageOld: number, ageNew: number, w: Weather): number {
    const t = this.tyres[c];
    let sec = baseLap(this.car, w) + t.paceOffsetSec + (t.degSecPerLap * (ageOld + ageNew)) / 2;
    if (t.weather !== w) sec += this.race.mismatchPenaltySec;
    const over = Math.max(0, ageOld + 1 - this.lives[c]) + Math.max(0, ageNew + 1 - this.lives[c]);
    if (over > 0) sec += (this.race.cliffPenaltySec * over) / 2;
    return sec;
  }

  stintCost(s: DraftStint, c: number, ageOld: number, ageNew: number): number {
    let sum = 0;
    for (let k = 0; k < s.laps; k++) sum += this.lapCost(c, ageOld + k, ageNew + k, s.lapWeather[k]);
    return sum;
  }

  maxLapsDry(): number {
    return Math.max(1, Math.floor((100 - this.race.veMarginPct) / Math.max(this.car.vePerLapDry, EPS)));
  }

  /** Splits N laps into stints, each at most `target` laps and within the VE budget. */
  buildStints(N: number, target: number, warnings?: string[]): DraftStint[] {
    const { race, car, start, j0 } = this;
    const out: DraftStint[] = [];
    let lap = 0;
    let t = start ? start.sec + race.pitLaneLossSec : 0;
    for (let j = 0; lap < N && j < 5000; j++) {
      const ov = this.inp.overrides[j0 + j];
      const locked = !!ov?.lockedLaps && ov.lockedLaps > 0;
      const limit = locked ? ov!.lockedLaps! : target;
      const capacity = (j === 0 && !start ? race.startVePct : 100) - race.veMarginPct;
      const w0 = weatherAt(race, t);
      let laps = 0;
      let ve = 0;
      const lw: Weather[] = [];
      while (lap + laps < N && laps < limit) {
        const w = weatherAt(race, t);
        if (!locked && laps > 0 && w !== w0) break;
        const need = vePerLap(car, w);
        if (laps > 0 && ve + need > capacity + EPS) {
          if (locked) warnings?.push(`Stint ${j0 + j + 1}: ${limit} locked laps exceed the VE budget, capped to ${laps}.`);
          break;
        }
        ve += need;
        laps++;
        lw.push(w);
        t += baseLap(car, w);
      }
      if (laps === 1 && ve > capacity + EPS) {
        warnings?.push(`Stint ${j0 + j + 1}: a single lap uses more VE than available.`);
      }
      out.push({ laps, lapWeather: lw, veUsed: ve });
      lap += laps;
      t += race.pitLaneLossSec + ve * race.refuelSecPerPct;
    }
    return out;
  }

  /** VE to add at the stop before the first stint of a re-plan. */
  preFill(stints: DraftStint[]): number {
    if (!this.start) return 0;
    return Math.max(0, Math.min(100, stints[0].veUsed + this.race.veMarginPct) - this.start.ve);
  }

  /** VE to add at the stop after each stint: only what the next stint needs. */
  fills(stints: DraftStint[], pre: number): number[] {
    const fills: number[] = [];
    let tank = this.start ? this.start.ve + pre : this.race.startVePct;
    for (let j = 0; j < stints.length; j++) {
      const end = tank - stints[j].veUsed;
      if (j === stints.length - 1) {
        fills.push(0);
        break;
      }
      const need = Math.min(100, stints[j + 1].veUsed + this.race.veMarginPct);
      const fill = Math.max(0, need - end);
      fills.push(fill);
      tank = end + fill;
    }
    return fills;
  }

  /** Driver swaps are left to the crew assignment, which avoids them when it can. */
  stopCost(fill: number, change: TyreChange): number {
    return makeStop(this.race, fill, change, false).totalSec;
  }

  /** Dynamic programming over stops: keep tyres, change 2 or change 4, and to which compound. */
  optimiseTyres(
    stints: DraftStint[],
    pre: number,
    fills: number[],
    warnings?: string[],
  ): { choices: TyreChoice[]; cost: number } {
    const T = this.tyres;
    const L = this.limits;
    const nC = T.length;
    const { j0 } = this;
    let stage = new Map<string, DPState>();
    const add = (map: Map<string, DPState>, s: DPState) => {
      const key = `${s.c}|${s.ageOld}|${s.ageNew}|${s.used.join(',')}`;
      const ex = map.get(key);
      if (!ex || s.cost < ex.cost) map.set(key, s);
    };
    // a re-plan continues from the tyres on the car
    const origin: DPState | null = this.start
      ? { cost: 0, c: this.start.c, ageOld: this.start.ageOld, ageNew: this.start.ageNew, used: this.start.used, change: 0, prev: null }
      : null;
    if (origin) stage.set('origin', origin);

    for (let j = 0; j < stints.length; j++) {
      const st = stints[j];
      const ov = this.inp.overrides[j0 + j];
      const fill = j === 0 ? pre : fills[j - 1];
      const next = new Map<string, DPState>();
      const generate = (ignoreOverride: boolean) => {
        const action = ignoreOverride ? 'auto' : (ov?.tyreAction ?? 'auto');
        const compoundOk = (c: number) => ignoreOverride || !ov?.compoundId || ov.compoundId === T[c].id;
        if (j === 0 && !origin) {
          for (let c = 0; c < nC; c++) {
            if (L[c] < 4 || !compoundOk(c)) continue;
            const used = new Array(nC).fill(0);
            used[c] = 4;
            add(next, {
              cost: this.stintCost(st, c, 0, 0),
              c,
              ageOld: st.laps,
              ageNew: st.laps,
              used,
              change: 4,
              prev: null,
            });
          }
          return;
        }
        const cost0 = this.stopCost(fill, 0);
        const cost2 = this.stopCost(fill, 2);
        const cost4 = this.stopCost(fill, 4);
        for (const s of stage.values()) {
          // keep all four
          if ((action === 'auto' || action === 'keep') && compoundOk(s.c)) {
            add(next, {
              cost: s.cost + cost0 + this.stintCost(st, s.c, s.ageOld, s.ageNew),
              c: s.c,
              ageOld: s.ageOld + st.laps,
              ageNew: s.ageNew + st.laps,
              used: s.used,
              change: 0,
              prev: s,
            });
          }
          // two new tyres on the older side, same compound
          if ((action === 'auto' || action === 'two') && compoundOk(s.c) && s.used[s.c] + 2 <= L[s.c]) {
            const used = s.used.slice();
            used[s.c] += 2;
            add(next, {
              cost: s.cost + cost2 + this.stintCost(st, s.c, s.ageNew, 0),
              c: s.c,
              ageOld: s.ageNew + st.laps,
              ageNew: st.laps,
              used,
              change: 2,
              prev: s,
            });
          }
          // four new tyres, any compound
          if (action === 'auto' || action === 'four') {
            for (let c = 0; c < nC; c++) {
              if (s.used[c] + 4 > L[c] || !compoundOk(c)) continue;
              const used = s.used.slice();
              used[c] += 4;
              add(next, {
                cost: s.cost + cost4 + this.stintCost(st, c, 0, 0),
                c,
                ageOld: st.laps,
                ageNew: st.laps,
                used,
                change: 4,
                prev: s,
              });
            }
          }
        }
      };
      generate(false);
      if (next.size === 0) {
        warnings?.push(`Stint ${j0 + j + 1}: no tyres left for the requested change, override ignored.`);
        generate(true);
      }
      if (next.size === 0) {
        // no tyres left at all: keep the current ones, the cliff penalty applies
        for (const s of stage.values()) {
          add(next, {
            cost: s.cost + this.stopCost(fill, 0) + this.stintCost(st, s.c, s.ageOld, s.ageNew),
            c: s.c,
            ageOld: s.ageOld + st.laps,
            ageNew: s.ageNew + st.laps,
            used: s.used,
            change: 0,
            prev: s,
          });
        }
      }
      if (next.size === 0) throw new Error('Not enough tyres: at least 4 tyres of one compound are needed.');
      if (next.size > BEAM) {
        const kept = [...next.entries()].sort((a, b) => a[1].cost - b[1].cost).slice(0, BEAM);
        stage = new Map(kept);
      } else {
        stage = next;
      }
    }

    let best: DPState | null = null;
    for (const s of stage.values()) if (!best || s.cost < best.cost) best = s;
    const choices: TyreChoice[] = [];
    for (let s = best; s && s !== origin; s = s.prev) choices.unshift({ c: s.c, change: s.change });
    return { choices, cost: best!.cost };
  }

  /** Pair ages at the start of each stint for the chosen tyre changes. */
  ages(stints: DraftStint[], choices: TyreChoice[]): [number, number][] {
    const out: [number, number][] = [];
    let old = this.start?.ageOld ?? 0;
    let neu = this.start?.ageNew ?? 0;
    stints.forEach((s, j) => {
      const ch = choices[j].change;
      if (ch === 4) old = neu = 0;
      else if (ch === 2) [old, neu] = [neu, 0];
      out.push([old, neu]);
      old += s.laps;
      neu += s.laps;
    });
    return out;
  }

  evaluate(N: number, target: number, warnings?: string[]): Candidate {
    const stints = this.buildStints(N, target, warnings);
    const pre = this.preFill(stints);
    const fills = this.fills(stints, pre);
    const { choices, cost } = this.optimiseTyres(stints, pre, fills, warnings);
    // time of the very last lap, used to know whether that lap starts before the clock ends
    const j = stints.length - 1;
    const [old, neu] = this.ages(stints, choices)[j];
    const last = stints[j];
    const k = last.laps - 1;
    const lastLap = this.lapCost(choices[j].c, old + k, neu + k, last.lapWeather[k]);
    return { stints, pre, fills, choices, cost, lastLap };
  }

  /** Best plan for exactly N laps, trying several stint counts (more stops = shorter stints, fresher tyres). */
  planForLaps(N: number): Candidate & { target: number } {
    const maxLaps = this.maxLapsDry();
    const kMin = Math.ceil(N / maxLaps);
    const targets = new Set<number>([maxLaps]);
    for (let extra = 0; extra <= 3; extra++) targets.add(Math.max(1, Math.ceil(N / (kMin + extra))));
    let best: (Candidate & { target: number }) | null = null;
    for (const target of targets) {
      const cand = this.evaluate(N, target);
      if (!best || cand.cost < best.cost - EPS) best = { ...cand, target };
    }
    return best!;
  }

  /** Timed race: the most laps whose last lap starts before the clock reaches zero. */
  planForTime(durationSec: number): Candidate & { target: number } {
    const { car, race } = this;
    const maxLaps = this.maxLapsDry();
    const avgLap =
      car.lapTimeDrySec + car.vePerLapDry * race.refuelSecPerPct + (race.pitLaneLossSec + race.driverChangeSec) / maxLaps;
    let N = Math.max(1, Math.floor(durationSec / avgLap));
    const valid = (c: Candidate) => c.cost - c.lastLap < durationSec;
    let plan = this.planForLaps(N);
    for (let i = 0; i < 500; i++) {
      if (!valid(plan)) {
        if (N === 1) break;
        plan = this.planForLaps(--N);
        continue;
      }
      const up = this.planForLaps(N + 1);
      if (!valid(up)) break;
      plan = up;
      N++;
    }
    return plan;
  }

  run(): { result: PlanResult; preStop: PitStop | null } {
    const { race, start } = this;
    const warnings: string[] = [];
    validate(this.inp);
    let chosen: Candidate & { target: number };
    if (race.mode === 'laps') {
      const N = Math.round(race.laps) - (start?.lap ?? 0);
      if (N < 1) throw new Error('No laps left to plan: the race distance is already covered.');
      chosen = this.planForLaps(N);
    } else {
      const left = race.durationMin * 60 - (start?.sec ?? 0);
      if (left <= 0) throw new Error('No race time left to plan.');
      chosen = this.planForTime(left);
    }
    const N = chosen.stints.reduce((a, s) => a + s.laps, 0);
    // re-run the winning option with warnings enabled
    const final = this.evaluate(N, chosen.target, warnings);
    return this.toResult(final, warnings);
  }

  toResult(cand: Candidate, warnings: string[]): { result: PlanResult; preStop: PitStop | null } {
    const { race, start, j0 } = this;
    const stints: Stint[] = [];
    const ages = this.ages(cand.stints, cand.choices);
    const preStop = start ? makeStop(race, cand.pre, cand.choices[0].change, false) : null;
    let t = start ? start.sec + preStop!.totalSec : 0;
    let lap = start?.lap ?? 0;
    let tank = start ? start.ve + cand.pre : race.startVePct;
    const tyresUsed: Partial<Record<string, number>> = {};
    if (start) this.tyres.forEach((tyre, c) => start.used[c] && (tyresUsed[tyre.name] = start.used[c]));
    for (let j = 0; j < cand.stints.length; j++) {
      const ds = cand.stints[j];
      const ch = cand.choices[j];
      const tyre = this.tyres[ch.c];
      if (ch.change) tyresUsed[tyre.name] = (tyresUsed[tyre.name] ?? 0) + ch.change;
      const [ageOld, ageNew] = ages[j];
      const driveSec = this.stintCost(ds, ch.c, ageOld, ageNew);
      const isLast = j === cand.stints.length - 1;
      const nextChange = isLast ? 0 : cand.choices[j + 1].change;
      const stop = isLast ? null : makeStop(race, cand.fills[j], nextChange, false);
      stints.push({
        index: j0 + j,
        startLap: lap + 1,
        endLap: lap + ds.laps,
        laps: ds.laps,
        wetLaps: ds.lapWeather.filter((w) => w === 'wet').length,
        weather: ds.lapWeather[0] ?? 'dry',
        startSec: t,
        endSec: t + driveSec,
        driveSec,
        avgLapSec: ds.laps ? driveSec / ds.laps : 0,
        compoundId: tyre.id,
        compoundName: tyre.name,
        tyreChange: j === 0 && !start ? 4 : ch.change,
        tyreAgeOld: ageOld,
        tyreAgeNew: ageNew,
        tyreWearEndPct: (ageOld + ds.laps) * tyre.wearPctPerLap,
        veStartPct: tank,
        veUsedPct: ds.veUsed,
        veEndPct: tank - ds.veUsed,
        stop,
      });
      lap += ds.laps;
      tank = tank - ds.veUsed + cand.fills[j];
      t += driveSec + (stop?.totalSec ?? 0);
    }
    for (const tyre of this.tyres) {
      if ((tyresUsed[tyre.name] ?? 0) > tyreLimit(tyre)) warnings.push(`${tyre.name}: more tyres used than available.`);
    }
    const result: PlanResult = {
      totalLaps: lap,
      totalSec: t,
      stops: j0 + stints.length - 1,
      stints,
      tyresUsed,
      warnings: [...new Set(warnings)],
      computedAt: new Date().toISOString(),
    };
    return { result, preStop };
  }
}

export function validate(inp: StrategyInputs): void {
  const { race, car } = inp;
  const errors: string[] = [];
  if (race.mode === 'time' && !(race.durationMin > 0)) errors.push('Race duration must be greater than 0.');
  if (race.mode === 'laps' && !(race.laps > 0)) errors.push('Race length (laps) must be greater than 0.');
  if (!(car.lapTimeDrySec > 0) || !(car.lapTimeWetSec > 0)) errors.push('Lap times must be greater than 0.');
  if (!(car.vePerLapDry > 0) || !(car.vePerLapWet > 0)) errors.push('VE per lap must be greater than 0.');
  if (car.vePerLapDry > 100 - race.veMarginPct) errors.push('VE per lap is higher than a full tank minus the margin.');
  if (!inp.tyres.some((t) => tyreLimit(t) >= 4)) errors.push('At least 4 tyres of one compound are required.');
  if (errors.length) throw new Error(errors.join(' '));
}

export function computeStrategy(inp: StrategyInputs): PlanResult {
  return new Planner(inp).run().result;
}

/** Number of stints already run in race mode: they are never recomputed. */
export function lockedCount(plan: PlanResult): number {
  return plan.live?.lockedStints ?? 0;
}

/**
 * Race mode: keeps the first `locked` stints as they were run and plans the rest of the race,
 * starting with the stop after the last locked stint (VE, tyres on the car and tyres used are carried over).
 */
export function replanFrom(inp: StrategyInputs, plan: PlanResult, locked: number): PlanResult {
  if (locked <= 0) return { ...computeStrategy(inp), live: plan.live };
  const done = plan.stints.slice(0, locked).map((s) => ({ ...s }));
  const last = done[locked - 1];
  const c = inp.tyres.findIndex((t) => t.id === last.compoundId);
  if (c < 0) throw new Error(`The compound on the car (${last.compoundName}) is no longer in the race setup.`);
  const used = inp.tyres.map((t) => done.reduce((a, s) => a + (s.compoundId === t.id ? s.tyreChange : 0), 0));
  const { result, preStop } = new Planner(inp, {
    stint: locked,
    lap: last.endLap,
    sec: last.endSec,
    ve: last.veEndPct,
    c,
    ageOld: last.tyreAgeOld + last.laps,
    ageNew: last.tyreAgeNew + last.laps,
    used,
  }).run();
  last.stop = preStop;
  return { ...result, stints: [...done, ...result.stints], live: plan.live };
}

function driverChanges(prev: StintAssignment | undefined, next: StintAssignment | undefined, drivers: number): boolean {
  if (drivers <= 1) return false;
  if (!prev?.driverId || !next?.driverId) return true;
  return prev.driverId !== next.driverId;
}

/**
 * Recomputes stop durations and the race clock once drivers are known (driver swaps only where the driver changes).
 * Locked stints keep the times they were run at; only the stop after the last one can still change.
 */
export function retime(plan: PlanResult, inp: StrategyInputs): PlanResult {
  const locked = lockedCount(plan);
  let t = 0;
  const stints = plan.stints.map((s, j) => {
    if (j < locked - 1) {
      t = s.endSec + (s.stop?.totalSec ?? 0);
      return s;
    }
    const stop = s.stop
      ? makeStop(
          inp.race,
          s.stop.refuelPct,
          s.stop.tyreCount,
          driverChanges(inp.assignments[j], inp.assignments[j + 1], inp.drivers.length),
        )
      : null;
    const startSec = j < locked ? s.startSec : t;
    const out: Stint = { ...s, startSec, endSec: startSec + s.driveSec, stop };
    t = out.endSec + (stop?.totalSec ?? 0);
    return out;
  });
  return { ...plan, stints, totalSec: t };
}

/**
 * Race mode: stint `j` actually ended (pit-in) at `endSec` on the race clock after `laps` laps.
 * Stints up to `j` become locked. The following stints keep their plan (laps, tyres) and are only shifted.
 */
export function recordPitIn(inp: StrategyInputs, plan: PlanResult, j: number, endSec: number, laps: number): PlanResult {
  const s0 = plan.stints[j];
  if (!(endSec > s0.startSec)) throw new Error(`Stint ${j + 1} cannot end before it starts.`);
  if (!(laps >= 1)) throw new Error('A stint has at least 1 lap.');
  const stints = plan.stints.map((s) => ({ ...s }));
  const s = stints[j];
  const ratio = s0.laps ? laps / s0.laps : 1;
  s.laps = laps;
  s.wetLaps = Math.min(laps, Math.round(s0.wetLaps * ratio));
  s.veUsedPct = s0.veUsedPct * ratio;
  s.endSec = endSec;
  s.driveSec = endSec - s.startSec;
  s.avgLapSec = s.driveSec / laps;

  // carry laps, tyre ages and VE through the next stints; their own plan is unchanged
  const wear = new Map(inp.tyres.map((t) => [t.id, t.wearPctPerLap]));
  let lap = s.startLap - 1;
  let old = s.tyreAgeOld;
  let neu = s.tyreAgeNew;
  let tank = s.veStartPct;
  for (let k = j; k < stints.length; k++) {
    const st = stints[k];
    if (k > j) {
      if (st.tyreChange === 4) old = neu = 0;
      else if (st.tyreChange === 2) [old, neu] = [neu, 0];
      st.tyreAgeOld = old;
      st.tyreAgeNew = neu;
      st.veStartPct = tank;
    }
    st.startLap = lap + 1;
    st.endLap = lap + st.laps;
    st.tyreWearEndPct = (old + st.laps) * (wear.get(st.compoundId) ?? 0);
    st.veEndPct = tank - st.veUsedPct;
    if (st.stop) {
      // refuel to what the next stint was planned to start with
      const refuel = k === j ? Math.max(0, Math.min(100, plan.stints[k + 1].veStartPct) - st.veEndPct) : st.stop.refuelPct;
      st.stop = makeStop(inp.race, refuel, st.stop.tyreCount, st.stop.driverChange);
      tank = st.veEndPct + refuel;
    }
    lap = st.endLap;
    old += st.laps;
    neu += st.laps;
  }
  return retime({ ...plan, stints, totalLaps: lap, live: { lockedStints: j + 1 } }, inp);
}

/** Race mode: how far the shifted plan is from the clock (timed race). Positive = finishes too late. */
export function finishGapSec(inp: StrategyInputs, plan: PlanResult): number | null {
  if (inp.race.mode !== 'time' || !plan.stints.length) return null;
  const last = plan.stints[plan.stints.length - 1];
  const D = inp.race.durationMin * 60;
  // the last lap must start before the clock reaches zero
  if (plan.totalSec - last.avgLapSec >= D) return plan.totalSec - last.avgLapSec - D;
  if (plan.totalSec < D) return plan.totalSec - D;
  return 0;
}
