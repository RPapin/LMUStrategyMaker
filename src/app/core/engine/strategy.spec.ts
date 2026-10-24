import { describe, expect, it } from 'vitest';
import { defaultInputs, newTyre } from '../defaults';
import { StrategyInputs } from '../models';
import { computeStrategy, finishGapSec, recordPitIn, replanFrom, retime } from './strategy';

function simple(): StrategyInputs {
  const inp = defaultInputs();
  inp.race.mode = 'laps';
  inp.race.laps = 100;
  inp.race.veMarginPct = 0;
  inp.car.vePerLapDry = 10; // 10 laps per tank
  inp.tyres = [newTyre({ name: 'Medium', tyres: 80, wearPctPerLap: 1, degSecPerLap: 0.05 })];
  inp.drivers.forEach((d) => (d.maxConsecutiveStints = 0));
  return inp;
}

describe('computeStrategy', () => {
  it('uses the minimum number of stops when VE limits the stint', () => {
    const plan = computeStrategy(simple());
    expect(plan.totalLaps).toBe(100);
    expect(plan.stints.length).toBe(10);
    expect(plan.stints.every((s) => s.laps === 10)).toBe(true);
    expect(plan.stints.every((s) => s.veUsedPct <= 100)).toBe(true);
  });

  it('refuels only what the last stint needs', () => {
    const inp = simple();
    inp.race.laps = 95;
    const plan = computeStrategy(inp);
    const lastStop = plan.stints[plan.stints.length - 2].stop!;
    const last = plan.stints[plan.stints.length - 1];
    expect(plan.stints.reduce((a, s) => a + s.laps, 0)).toBe(95);
    expect(last.veEndPct).toBeGreaterThanOrEqual(-1e-9);
    expect(lastStop.refuelPct).toBeLessThan(100);
  });

  it('changes tyres when the change is free (parallel service)', () => {
    const inp = simple();
    inp.race.serviceParallel = true;
    inp.race.tyreChange4Sec = 20; // refuel 100% * 0.35 = 35s > 20s
    const plan = computeStrategy(inp);
    expect(plan.stints.every((s) => s.tyreChange === 4)).toBe(true);
  });

  it('keeps tyres when the change costs more than the degradation', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    inp.race.tyreChange4Sec = 30;
    inp.race.tyreChange2Sec = 20;
    inp.tyres[0].degSecPerLap = 0.01;
    const plan = computeStrategy(inp);
    expect(plan.stints.filter((s) => s.tyreChange > 0).length).toBe(1);
  });

  it('never uses more sets than available', () => {
    const inp = simple();
    inp.tyres[0].tyres = 14;
    inp.tyres[0].degSecPerLap = 0.5;
    const plan = computeStrategy(inp);
    expect(plan.tyresUsed['Medium']).toBeLessThanOrEqual(14);
  });

  it('fits a timed race: last lap starts before the clock ends', () => {
    const inp = defaultInputs();
    const plan = computeStrategy(inp);
    const D = inp.race.durationMin * 60;
    const last = plan.stints[plan.stints.length - 1];
    expect(plan.totalSec).toBeGreaterThanOrEqual(D);
    expect(plan.totalSec - last.avgLapSec * 1.5).toBeLessThan(D);
    expect(plan.totalLaps).toBeGreaterThan(150);
  });

  it('puts wet tyres on during a wet window', () => {
    const inp = defaultInputs();
    inp.race.weather = [{ id: 'w', fromMin: 120, toMin: 200, weather: 'wet' }];
    const plan = computeStrategy(inp);
    const wet = plan.stints.filter((s) => s.weather === 'wet');
    expect(wet.length).toBeGreaterThan(0);
    expect(wet.every((s) => s.compoundName === 'Wet')).toBe(true);
  });

  it('respects locked stint length and tyre overrides', () => {
    const inp = simple();
    inp.overrides[0] = { lockedLaps: 6, tyreAction: 'auto', compoundId: null };
    inp.overrides[2] = { lockedLaps: null, tyreAction: 'keep', compoundId: null };
    const plan = computeStrategy(inp);
    expect(plan.stints[0].laps).toBe(6);
    expect(plan.stints[2].tyreChange).toBe(0);
  });

  it('retime adds driver swap time only where the driver changes', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    const plan = computeStrategy(inp);
    inp.assignments = plan.stints.map((_, j) => ({
      driverId: j < 5 ? 'a' : 'b',
      spotterId: null,
      driverLocked: false,
      spotterLocked: false,
    }));
    const re = retime(plan, inp);
    expect(re.stints.filter((s) => s.stop?.driverChange).map((s) => s.index)).toEqual([4]);
    expect(re.totalSec).toBeCloseTo(plan.totalSec + inp.race.driverChangeSec, 6);
  });

  it('keeps tyres over many stints when changing them costs time (drivers can change anyway)', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    inp.race.tyreChange4Sec = 30;
    inp.race.tyreChange2Sec = 25;
    inp.tyres[0].degSecPerLap = 0.001;
    inp.drivers.forEach((d) => (d.maxConsecutiveStints = 2));
    const plan = computeStrategy(inp);
    expect(plan.stints.filter((s) => s.tyreChange === 4).length).toBe(1);
  });

  it('never runs out of wet tyres', () => {
    const inp = defaultInputs();
    inp.race.weather = [{ id: 'w', fromMin: 0, toMin: 360, weather: 'wet' }];
    const wet = inp.tyres.find((t) => t.weather === 'wet')!;
    wet.tyres = 0;
    wet.degSecPerLap = 0.5;
    const plan = computeStrategy(inp);
    expect(plan.stints.every((s) => s.compoundName === 'Wet')).toBe(true);
    expect(plan.tyresUsed['Wet']).toBeGreaterThan(8);
    expect(plan.warnings).toEqual([]);
  });

  it('changes only 2 tyres when tyres are short and 2 tyres are quick', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    inp.race.tyreChange4Sec = 13;
    inp.race.tyreChange2Sec = 6;
    inp.drivers = inp.drivers.slice(0, 1); // no driver change cost, isolate the tyre trade-off
    inp.tyres[0].tyres = 24; // not enough for 4 new tyres at every stop
    inp.tyres[0].degSecPerLap = 0.1;
    const plan = computeStrategy(inp);
    expect(plan.stints.some((s) => s.tyreChange === 2)).toBe(true);
    expect(plan.tyresUsed['Medium']).toBeLessThanOrEqual(24);
    const two = plan.stints.find((s) => s.tyreChange === 2)!;
    expect(two.tyreAgeNew).toBe(0);
    expect(two.tyreAgeOld).toBeGreaterThan(0);
    expect(plan.stints[two.index - 1].stop!.tyreSec).toBe(6);
  });

  it('respects a forced 2-tyre change', () => {
    const inp = simple();
    inp.overrides[3] = { lockedLaps: null, tyreAction: 'two', compoundId: null };
    const plan = computeStrategy(inp);
    expect(plan.stints[3].tyreChange).toBe(2);
  });

  it('runs a 24h race fast enough', () => {
    const inp = defaultInputs();
    inp.race.durationMin = 24 * 60;
    inp.tyres.forEach((t) => (t.tyres = 48));
    const t0 = performance.now();
    const plan = computeStrategy(inp);
    expect(plan.totalLaps).toBeGreaterThan(600);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});

describe('race mode', () => {
  function started(): { inp: StrategyInputs; plan: ReturnType<typeof computeStrategy> } {
    const inp = defaultInputs();
    const plan = { ...computeStrategy(inp), live: { lockedStints: 0 } };
    return { inp, plan };
  }

  it('locks the stints up to an early pit-in and shifts the next ones', () => {
    const { inp, plan } = started();
    const s = plan.stints[2];
    const early = s.endSec - 5 * s.avgLapSec;
    const res = recordPitIn(inp, plan, 2, early, s.laps - 5);
    expect(res.live!.lockedStints).toBe(3);
    expect(res.stints.slice(0, 2)).toEqual(plan.stints.slice(0, 2));
    expect(res.stints[2].endSec).toBeCloseTo(early, 6);
    expect(res.stints[2].laps).toBe(s.laps - 5);
    expect(res.stints[3].startLap).toBe(res.stints[2].endLap + 1);
    expect(res.stints[3].laps).toBe(plan.stints[3].laps);
    expect(res.stints[3].tyreChange).toBe(plan.stints[3].tyreChange);
    // more VE left in the tank: shorter refuel, the next stint starts as planned
    expect(res.stints[2].stop!.refuelPct).toBeLessThan(s.stop!.refuelPct);
    expect(res.stints[3].veStartPct).toBeCloseTo(plan.stints[3].veStartPct, 6);
    expect(res.stints[3].startSec).toBeCloseTo(early + res.stints[2].stop!.totalSec, 6);
    expect(res.totalLaps).toBe(plan.totalLaps - 5);
    expect(finishGapSec(inp, res)).toBeLessThan(0);
  });

  it('re-plans after the locked stints and keeps them untouched', () => {
    const { inp, plan } = started();
    const s = plan.stints[2];
    const pitted = recordPitIn(inp, plan, 2, s.endSec - 5 * s.avgLapSec, s.laps - 5);
    const re = replanFrom(inp, pitted, 3);
    const D = inp.race.durationMin * 60;
    expect(re.live!.lockedStints).toBe(3);
    for (let j = 0; j < 3; j++) {
      const { stop: _a, ...a } = re.stints[j];
      const { stop: _b, ...b } = pitted.stints[j];
      expect(a).toEqual(b);
    }
    re.stints.forEach((st, j) => expect(st.index).toBe(j));
    const first = re.stints[3];
    expect(first.startLap).toBe(pitted.stints[2].endLap + 1);
    expect(first.startSec).toBeCloseTo(pitted.stints[2].endSec + re.stints[2].stop!.totalSec, 6);
    expect(first.veStartPct).toBeCloseTo(pitted.stints[2].veEndPct + re.stints[2].stop!.refuelPct, 6);
    // fits the clock again
    const last = re.stints[re.stints.length - 1];
    expect(re.totalSec).toBeGreaterThanOrEqual(D);
    expect(re.totalSec - last.avgLapSec * 1.5).toBeLessThan(D);
    // tyres used before the pit are counted
    const total = Object.values(re.tyresUsed).reduce((a, n) => a! + n!, 0)!;
    expect(total).toBe(re.stints.reduce((a, st) => a + st.tyreChange, 0));
  });

  it('continues on the tyres on the car when they are kept', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    inp.race.tyreChange4Sec = 30;
    inp.race.tyreChange2Sec = 25;
    inp.tyres[0].degSecPerLap = 0.001;
    const plan = { ...computeStrategy(inp), live: { lockedStints: 0 } };
    const pitted = recordPitIn(inp, plan, 1, plan.stints[1].endSec, plan.stints[1].laps);
    const re = replanFrom(inp, pitted, 2);
    expect(re.totalLaps).toBe(100);
    expect(re.stints[2].tyreChange).toBe(0);
    expect(re.stints[2].tyreAgeOld).toBe(re.stints[1].tyreAgeOld + re.stints[1].laps);
  });

  it('retime keeps the real times of locked stints', () => {
    const { inp, plan } = started();
    const s = plan.stints[1];
    const pitted = recordPitIn(inp, plan, 1, s.endSec + 120, s.laps);
    inp.assignments = pitted.stints.map(() => ({ driverId: 'x', spotterId: null, driverLocked: false, spotterLocked: false }));
    const re = retime(pitted, inp);
    expect(re.stints[1].endSec).toBeCloseTo(s.endSec + 120, 6);
    expect(re.stints[0].startSec).toBe(0);
    expect(re.stints[2].startSec).toBeCloseTo(re.stints[1].endSec + re.stints[1].stop!.totalSec, 6);
  });

  it('refuses a pit-in before the stint starts', () => {
    const { inp, plan } = started();
    expect(() => recordPitIn(inp, plan, 2, plan.stints[2].startSec - 1, 3)).toThrow();
  });
});
