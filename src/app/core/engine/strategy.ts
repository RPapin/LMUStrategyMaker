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
  /** Stints run since the last 4-tyre change (= stints for the current driver). */
  run: number;
  used: number[];
  change: TyreChange;
  prev: DPState | null;
}

class Planner {
  private readonly race: RaceSettings;
  private readonly car: CarSettings;
  private readonly tyres: TyreCompound[];
  private readonly lives: number[];
  /** Driver swaps only happen at stops where all 4 tyres are changed. */
  private readonly assumeSwap: boolean;
  /** Longest tyre block allowed: a driver can't stay in longer than their max stints in a row. */
  private readonly maxRun: number;

  constructor(private readonly inp: StrategyInputs) {
    this.race = inp.race;
    this.car = inp.car;
    this.tyres = inp.tyres;
    this.lives = inp.tyres.map(tyreLife);
    this.assumeSwap = inp.drivers.length > 1;
    const limits = inp.drivers.map((d) => d.maxConsecutiveStints);
    this.maxRun = limits.length && limits.every((l) => l > 0) ? Math.max(...limits) : 0;
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
    const { race, car } = this;
    const out: DraftStint[] = [];
    let lap = 0;
    let t = 0;
    for (let j = 0; lap < N && j < 5000; j++) {
      const ov = this.inp.overrides[j];
      const locked = !!ov?.lockedLaps && ov.lockedLaps > 0;
      const limit = locked ? ov!.lockedLaps! : target;
      const capacity = (j === 0 ? race.startVePct : 100) - race.veMarginPct;
      const w0 = weatherAt(race, t);
      let laps = 0;
      let ve = 0;
      const lw: Weather[] = [];
      while (lap + laps < N && laps < limit) {
        const w = weatherAt(race, t);
        if (!locked && laps > 0 && w !== w0) break;
        const need = vePerLap(car, w);
        if (laps > 0 && ve + need > capacity + EPS) {
          if (locked) warnings?.push(`Stint ${j + 1}: ${limit} locked laps exceed the VE budget, capped to ${laps}.`);
          break;
        }
        ve += need;
        laps++;
        lw.push(w);
        t += baseLap(car, w);
      }
      if (laps === 1 && ve > capacity + EPS) {
        warnings?.push(`Stint ${j + 1}: a single lap uses more VE than available.`);
      }
      out.push({ laps, lapWeather: lw, veUsed: ve });
      lap += laps;
      t += race.pitLaneLossSec + ve * race.refuelSecPerPct;
    }
    return out;
  }

  /** VE to add at the stop after each stint: only what the next stint needs. */
  fills(stints: DraftStint[]): number[] {
    const fills: number[] = [];
    let tank = this.race.startVePct;
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

  stopCost(fill: number, change: TyreChange): number {
    return makeStop(this.race, fill, change, this.assumeSwap && change === 4).totalSec;
  }

  /** Dynamic programming over stops: keep tyres, change 2 or change 4, and to which compound. */
  optimiseTyres(stints: DraftStint[], fills: number[], warnings?: string[]): { choices: TyreChoice[]; cost: number } {
    const T = this.tyres;
    const nC = T.length;
    let stage = new Map<string, DPState>();
    const add = (map: Map<string, DPState>, s: DPState) => {
      const key = `${s.c}|${s.ageOld}|${s.ageNew}|${s.run}|${s.used.join(',')}`;
      const ex = map.get(key);
      if (!ex || s.cost < ex.cost) map.set(key, s);
    };

    for (let j = 0; j < stints.length; j++) {
      const st = stints[j];
      const ov = this.inp.overrides[j];
      const next = new Map<string, DPState>();
      const generate = (ignoreOverride: boolean) => {
        const action = ignoreOverride ? 'auto' : (ov?.tyreAction ?? 'auto');
        const compoundOk = (c: number) => ignoreOverride || !ov?.compoundId || ov.compoundId === T[c].id;
        if (j === 0) {
          for (let c = 0; c < nC; c++) {
            if (T[c].tyres < 4 || !compoundOk(c)) continue;
            const used = new Array(nC).fill(0);
            used[c] = 4;
            add(next, {
              cost: this.stintCost(st, c, 0, 0),
              c,
              ageOld: st.laps,
              ageNew: st.laps,
              run: 1,
              used,
              change: 4,
              prev: null,
            });
          }
          return;
        }
        const cost0 = this.stopCost(fills[j - 1], 0);
        const cost2 = this.stopCost(fills[j - 1], 2);
        const cost4 = this.stopCost(fills[j - 1], 4);
        for (const s of stage.values()) {
          // keep all four / two new: the driver stays in, so the run continues
          const canStay = !this.maxRun || s.run < this.maxRun;
          if ((action === 'auto' || action === 'keep') && compoundOk(s.c) && (canStay || action === 'keep')) {
            add(next, {
              cost: s.cost + cost0 + this.stintCost(st, s.c, s.ageOld, s.ageNew),
              c: s.c,
              ageOld: s.ageOld + st.laps,
              ageNew: s.ageNew + st.laps,
              run: s.run + 1,
              used: s.used,
              change: 0,
              prev: s,
            });
          }
          // two new tyres on the older side, same compound
          if (
            (action === 'auto' || action === 'two') &&
            compoundOk(s.c) &&
            (canStay || action === 'two') &&
            s.used[s.c] + 2 <= T[s.c].tyres
          ) {
            const used = s.used.slice();
            used[s.c] += 2;
            add(next, {
              cost: s.cost + cost2 + this.stintCost(st, s.c, s.ageNew, 0),
              c: s.c,
              ageOld: s.ageNew + st.laps,
              ageNew: st.laps,
              run: s.run + 1, // same driver: no swap on a 2-tyre stop
              used,
              change: 2,
              prev: s,
            });
          }
          // four new tyres, any compound
          if (action === 'auto' || action === 'four') {
            for (let c = 0; c < nC; c++) {
              if (s.used[c] + 4 > T[c].tyres || !compoundOk(c)) continue;
              const used = s.used.slice();
              used[c] += 4;
              add(next, {
                cost: s.cost + cost4 + this.stintCost(st, c, 0, 0),
                c,
                ageOld: st.laps,
                ageNew: st.laps,
                run: 1,
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
        warnings?.push(
          `Stint ${j + 1}: no tyres left for the requested change (override or drivers' max stints in a row), ignored.`,
        );
        generate(true);
      }
      if (next.size === 0) {
        // no tyres left at all: keep the current ones, the cliff penalty applies
        for (const s of stage.values()) {
          add(next, {
            cost: s.cost + this.stopCost(fills[j - 1], 0) + this.stintCost(st, s.c, s.ageOld, s.ageNew),
            c: s.c,
            ageOld: s.ageOld + st.laps,
            ageNew: s.ageNew + st.laps,
            run: s.run + 1,
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
    for (let s = best; s; s = s.prev) choices.unshift({ c: s.c, change: s.change });
    return { choices, cost: best!.cost };
  }

  /** Pair ages at the start of each stint for the chosen tyre changes. */
  ages(stints: DraftStint[], choices: TyreChoice[]): [number, number][] {
    const out: [number, number][] = [];
    let old = 0;
    let neu = 0;
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
    const fills = this.fills(stints);
    const { choices, cost } = this.optimiseTyres(stints, fills, warnings);
    // time of the very last lap, used to know whether that lap starts before the clock ends
    const j = stints.length - 1;
    const [old, neu] = this.ages(stints, choices)[j];
    const last = stints[j];
    const k = last.laps - 1;
    const lastLap = this.lapCost(choices[j].c, old + k, neu + k, last.lapWeather[k]);
    return { stints, fills, choices, cost, lastLap };
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

  run(): PlanResult {
    const { race } = this;
    const warnings: string[] = [];
    validate(this.inp);
    const chosen =
      race.mode === 'laps' ? this.planForLaps(Math.max(1, Math.round(race.laps))) : this.planForTime(race.durationMin * 60);
    const N = chosen.stints.reduce((a, s) => a + s.laps, 0);
    // re-run the winning option with warnings enabled
    const final = this.evaluate(N, chosen.target, warnings);
    return this.toResult(final, warnings);
  }

  toResult(cand: Candidate, warnings: string[]): PlanResult {
    const { race } = this;
    const stints: Stint[] = [];
    const ages = this.ages(cand.stints, cand.choices);
    let t = 0;
    let lap = 0;
    let tank = race.startVePct;
    const tyresUsed: Partial<Record<string, number>> = {};
    for (let j = 0; j < cand.stints.length; j++) {
      const ds = cand.stints[j];
      const ch = cand.choices[j];
      const tyre = this.tyres[ch.c];
      if (ch.change) tyresUsed[tyre.name] = (tyresUsed[tyre.name] ?? 0) + ch.change;
      const [ageOld, ageNew] = ages[j];
      const driveSec = this.stintCost(ds, ch.c, ageOld, ageNew);
      const isLast = j === cand.stints.length - 1;
      const nextChange = isLast ? 0 : cand.choices[j + 1].change;
      const stop = isLast ? null : makeStop(race, cand.fills[j], nextChange, this.assumeSwap && nextChange === 4);
      stints.push({
        index: j,
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
        tyreChange: j === 0 ? 4 : ch.change,
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
      if ((tyresUsed[tyre.name] ?? 0) > tyre.tyres) warnings.push(`${tyre.name}: more tyres used than available.`);
    }
    return {
      totalLaps: lap,
      totalSec: t,
      stops: stints.length - 1,
      stints,
      tyresUsed,
      warnings: [...new Set(warnings)],
      computedAt: new Date().toISOString(),
    };
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
  if (!inp.tyres.some((t) => t.tyres >= 4)) errors.push('At least 4 tyres of one compound are required.');
  if (errors.length) throw new Error(errors.join(' '));
}

export function computeStrategy(inp: StrategyInputs): PlanResult {
  return new Planner(inp).run();
}

function driverChanges(prev: StintAssignment | undefined, next: StintAssignment | undefined, drivers: number): boolean {
  if (drivers <= 1) return false;
  if (!prev?.driverId || !next?.driverId) return true;
  return prev.driverId !== next.driverId;
}

/** Recomputes stop durations and the race clock once drivers are known (driver swaps only where the driver changes). */
export function retime(plan: PlanResult, inp: StrategyInputs): PlanResult {
  let t = 0;
  const stints = plan.stints.map((s, j) => {
    const stop = s.stop
      ? makeStop(
          inp.race,
          s.stop.refuelPct,
          s.stop.tyreCount,
          s.stop.tyreCount === 4 && driverChanges(inp.assignments[j], inp.assignments[j + 1], inp.drivers.length),
        )
      : null;
    const out: Stint = { ...s, startSec: t, endSec: t + s.driveSec, stop };
    t += s.driveSec + (stop?.totalSec ?? 0);
    return out;
  });
  return { ...plan, stints, totalSec: t };
}
