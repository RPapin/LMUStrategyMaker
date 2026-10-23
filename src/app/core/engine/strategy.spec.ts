import { describe, expect, it } from 'vitest';
import { defaultInputs, newTyre } from '../defaults';
import { StrategyInputs } from '../models';
import { computeStrategy, retime } from './strategy';

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

  it('retime removes driver swap time when the same driver stays in', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    const plan = computeStrategy(inp);
    inp.assignments = plan.stints.map(() => ({ driverId: 'a', spotterId: null, driverLocked: false, spotterLocked: false }));
    const re = retime(plan, inp);
    const tyreStops = plan.stints.filter((s) => s.stop?.tyreCount === 4).length;
    expect(re.totalSec).toBeCloseTo(plan.totalSec - tyreStops * inp.race.driverChangeSec, 6);
  });

  it('only counts driver change time at 4-tyre stops', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    inp.race.tyreChange4Sec = 30;
    inp.race.tyreChange2Sec = 25;
    inp.tyres[0].degSecPerLap = 0.01;
    const plan = computeStrategy(inp);
    expect(plan.stints.some((s) => s.stop && !s.stop.tyreCount)).toBe(true);
    for (const s of plan.stints) if (s.stop) expect(s.stop.driverChange).toBe(s.stop.tyreCount === 4);
  });

  it('changes tyres at least every max-stints-in-a-row so a driver can get out', () => {
    const inp = simple();
    inp.race.serviceParallel = false;
    inp.race.tyreChange4Sec = 30;
    inp.race.tyreChange2Sec = 25;
    inp.tyres[0].degSecPerLap = 0.001;
    inp.drivers.forEach((d) => (d.maxConsecutiveStints = 2));
    const plan = computeStrategy(inp);
    let run = 0;
    for (const s of plan.stints) {
      run = s.tyreChange === 4 ? 1 : run + 1;
      expect(run).toBeLessThanOrEqual(2);
    }
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
