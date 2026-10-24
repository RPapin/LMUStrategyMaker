import { describe, expect, it } from 'vitest';
import { defaultInputs, newDriver, tyresForCategory } from '../defaults';
import { startEpoch } from '../util';
import { assignCrew, availabilityFor, crewIssues, crewTotals, setAvailability } from './assign';
import { computeStrategy } from './strategy';

describe('assignCrew', () => {
  it('equalises driving time', () => {
    const inp = defaultInputs();
    const plan = computeStrategy(inp);
    inp.assignments = assignCrew(inp, plan);
    const totals = crewTotals(inp, plan).map((t) => t.driveSec);
    const max = Math.max(...totals);
    const min = Math.min(...totals);
    // a driver change is avoided unless it improves the balance a lot
    expect(max - min).toBeLessThanOrEqual(1.5 * Math.max(...plan.stints.map((s) => s.driveSec)));
  });

  it('never picks an unavailable driver and never spots while driving', () => {
    const inp = defaultInputs();
    const plan = computeStrategy(inp);
    const start = startEpoch(inp.race.startTime);
    setAvailability(inp.drivers[0], start, start + 3 * 3600_000, 'unavailable');
    inp.assignments = assignCrew(inp, plan);
    plan.stints.forEach((s, j) => {
      const a = inp.assignments[j];
      if (s.endSec < 3 * 3600 - 300) expect(a.driverId).not.toBe(inp.drivers[0].id);
      expect(a.spotterId).not.toBe(a.driverId);
    });
  });

  it('keeps locked drivers', () => {
    const inp = defaultInputs();
    const plan = computeStrategy(inp);
    inp.assignments = plan.stints.map(() => ({ driverId: null, spotterId: null, driverLocked: false, spotterLocked: false }));
    inp.assignments[0] = { driverId: inp.drivers[2].id, spotterId: null, driverLocked: true, spotterLocked: false };
    const res = assignCrew(inp, plan);
    expect(res[0].driverId).toBe(inp.drivers[2].id);
  });

  it('keeps driver changes to what the stint limits need', () => {
    const inp = defaultInputs();
    inp.drivers.forEach((d) => (d.maxConsecutiveStints = 3));
    const plan = computeStrategy(inp);
    inp.assignments = assignCrew(inp, plan);
    const changes = plan.stints.filter((_, j) => j > 0 && inp.assignments[j].driverId !== inp.assignments[j - 1].driverId);
    expect(changes.length).toBeLessThanOrEqual(Math.ceil(plan.stints.length / 3));
    expect(crewIssues(inp, plan).filter((i) => i.includes('in a row'))).toEqual([]);
  });

  it('can change driver at a stop without new tyres', () => {
    const inp = defaultInputs();
    inp.race.serviceParallel = false;
    inp.race.tyreChange4Sec = 40;
    inp.race.tyreChange2Sec = 35;
    inp.tyres.forEach((t) => (t.degSecPerLap = 0.001));
    inp.drivers.forEach((d) => (d.maxConsecutiveStints = 2));
    const plan = computeStrategy(inp);
    expect(plan.stints.filter((s) => s.tyreChange === 4).length).toBeLessThan(plan.stints.length / 2);
    inp.assignments = assignCrew(inp, plan);
    expect(crewIssues(inp, plan)).toEqual([]);
  });

    it('gives the extra driving time to the highest priority driver', () => {
    for (const top of [0, 1, 2]) {
      const inp = defaultInputs();
      inp.drivers.forEach((d, i) => (d.priority = i === top ? 1 : 2));
      const plan = computeStrategy(inp);
      inp.assignments = assignCrew(inp, plan);
      const totals = crewTotals(inp, plan).map((t) => t.driveSec);
      expect(totals.indexOf(Math.max(...totals))).toBe(top);
    }
  });

  it('respects max driving time', () => {
    const inp = defaultInputs();
    inp.drivers.push(newDriver(3));
    inp.drivers[0].maxDriveMin = 45;
    const plan = computeStrategy(inp);
    inp.assignments = assignCrew(inp, plan);
    const t = crewTotals(inp, plan)[0];
    expect(t.driveSec).toBeLessThanOrEqual(45 * 60);
  });
});

describe('availability windows', () => {
  it('splits and merges windows', () => {
    const d = newDriver(0);
    setAvailability(d, 0, 100, 'unavailable');
    setAvailability(d, 40, 60, 'available');
    expect(d.availability).toEqual([
      { from: 0, to: 40, status: 'unavailable' },
      { from: 60, to: 100, status: 'unavailable' },
    ]);
    setAvailability(d, 40, 60, 'unavailable');
    expect(d.availability).toEqual([{ from: 0, to: 100, status: 'unavailable' }]);
  });

  it('tolerates a small overlap', () => {
    const d = newDriver(0);
    setAvailability(d, 0, 60_000, 'unavailable');
    expect(availabilityFor(d, 0, 3600_000)).toBe('available');
    expect(availabilityFor(d, 0, 30_000)).toBe('unavailable');
  });
});

describe('categories', () => {
  it('only Hypercars get Soft and Hard', () => {
    expect(tyresForCategory('hypercar').map((t) => t.name)).toEqual(['Soft', 'Medium', 'Hard', 'Wet']);
    expect(tyresForCategory('lmp2').map((t) => t.name)).toEqual(['Medium', 'Wet']);
    expect(tyresForCategory('gt3').map((t) => t.name)).toEqual(['Medium', 'Wet']);
  });

  it('keeps values entered for a compound when switching category', () => {
    const hyper = tyresForCategory('hypercar');
    hyper[1].tyres = 30;
    const gt3 = tyresForCategory('gt3', hyper);
    expect(gt3[0].tyres).toBe(30);
    expect(gt3[0].id).toBe(hyper[1].id);
  });
});
