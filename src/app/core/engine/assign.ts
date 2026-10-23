import { Availability, AvailabilityWindow, Driver, PlanResult, StintAssignment, StrategyInputs } from '../models';
import { startEpoch } from '../util';

/** Unavailable for more than this inside a stint means the driver cannot do it. */
const UNAVAILABLE_TOLERANCE_MS = 5 * 60_000;

const HARD = 1e6;
const SOFT = 1e4;

export function emptyAssignment(): StintAssignment {
  return { driverId: null, spotterId: null, driverLocked: false, spotterLocked: false };
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Availability of a driver over a real-time range (epoch ms). */
export function availabilityFor(driver: Driver, from: number, to: number): Availability {
  let unavailable = 0;
  let preferred = 0;
  for (const w of driver.availability) {
    const o = overlap(from, to, w.from, w.to);
    if (w.status === 'unavailable') unavailable += o;
    else preferred += o;
  }
  if (unavailable > UNAVAILABLE_TOLERANCE_MS || (unavailable > 0 && unavailable >= (to - from) / 2)) return 'unavailable';
  if (preferred >= (to - from) / 2) return 'preferred';
  return 'available';
}

/** Sets the availability of a driver on a real-time range, replacing what was there. */
export function setAvailability(driver: Driver, from: number, to: number, status: Availability): void {
  const out: AvailabilityWindow[] = [];
  for (const w of driver.availability) {
    if (w.to <= from || w.from >= to) {
      out.push(w);
      continue;
    }
    if (w.from < from) out.push({ ...w, to: from });
    if (w.to > to) out.push({ ...w, from: to });
  }
  if (status !== 'available') out.push({ from, to, status });
  out.sort((a, b) => a.from - b.from);
  // merge touching windows with the same status
  const merged: AvailabilityWindow[] = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && last.status === w.status && last.to >= w.from) last.to = Math.max(last.to, w.to);
    else merged.push({ ...w });
  }
  driver.availability = merged;
}

export function stintRealRange(inp: StrategyInputs, plan: PlanResult, j: number): [number, number] {
  const start = startEpoch(inp.race.startTime);
  const s = plan.stints[j];
  return [start + s.startSec * 1000, start + s.endSec * 1000];
}

export function availabilityMatrix(inp: StrategyInputs, plan: PlanResult): Availability[][] {
  return plan.stints.map((_, j) => {
    const [from, to] = stintRealRange(inp, plan, j);
    return inp.drivers.map((d) => availabilityFor(d, from, to));
  });
}

/** Water-filling: equal share of the total, but nobody above their max or what their availability allows. */
export function driveTargets(inp: StrategyInputs, plan: PlanResult, avail: Availability[][]): number[] {
  const total = plan.stints.reduce((a, s) => a + s.driveSec, 0);
  const caps = inp.drivers.map((d, i) => {
    const possible = plan.stints.reduce((a, s, j) => a + (avail[j][i] === 'unavailable' ? 0 : s.driveSec), 0);
    return Math.min(possible, d.maxDriveMin != null ? d.maxDriveMin * 60 : Infinity);
  });
  const targets = new Array(inp.drivers.length).fill(0);
  let remaining = total;
  let open = inp.drivers.map((_, i) => i);
  while (open.length && remaining > 1e-6) {
    const share = remaining / open.length;
    const capped = open.filter((i) => caps[i] - targets[i] <= share);
    if (!capped.length) {
      for (const i of open) targets[i] += share;
      break;
    }
    for (const i of capped) {
      remaining -= caps[i] - targets[i];
      targets[i] = caps[i];
    }
    open = open.filter((i) => !capped.includes(i));
  }
  return targets;
}

interface Ctx {
  inp: StrategyInputs;
  plan: PlanResult;
  avail: Availability[][];
  targets: number[];
}

/** Lower is better. Drivers given as index into inp.drivers, -1 = nobody. */
function cost(ctx: Ctx, drv: number[]): number {
  const { inp, plan, avail, targets } = ctx;
  const n = inp.drivers.length;
  const time = new Array(n).fill(0);
  let c = 0;
  for (let j = 0; j < drv.length; j++) {
    const d = drv[j];
    if (d < 0) {
      c += HARD;
      continue;
    }
    time[d] += plan.stints[j].driveSec;
    if (avail[j][d] === 'unavailable') c += HARD;
    else if (avail[j][d] === 'preferred') c -= 5;
    if (j > 0 && drv[j - 1] !== d) c += 0.5;
  }
  // consecutive stints and rest between blocks
  const lastEnd = new Array(n).fill(-Infinity);
  for (let j = 0; j < drv.length; ) {
    const d = drv[j];
    let k = j;
    while (k + 1 < drv.length && drv[k + 1] === d) k++;
    if (d >= 0) {
      const driver = inp.drivers[d];
      const run = k - j + 1;
      if (driver.maxConsecutiveStints > 0 && run > driver.maxConsecutiveStints)
        c += HARD * (run - driver.maxConsecutiveStints);
      const rest = plan.stints[j].startSec - lastEnd[d];
      if (driver.minRestMin > 0 && rest < driver.minRestMin * 60) c += HARD;
      lastEnd[d] = plan.stints[k].endSec;
    }
    j = k + 1;
  }
  for (let i = 0; i < n; i++) {
    const driver = inp.drivers[i];
    const dev = (time[i] - targets[i]) / 60;
    c += dev * dev;
    if (driver.maxDriveMin != null && time[i] > driver.maxDriveMin * 60) c += SOFT * (1 + (time[i] - driver.maxDriveMin * 60) / 60);
    if (driver.minDriveMin != null && time[i] < driver.minDriveMin * 60) c += SOFT * (1 + (driver.minDriveMin * 60 - time[i]) / 60);
  }
  return c;
}

/** Stint ranges [from, to] driven by one driver. A new block starts at each 4-tyre change. */
export function tyreBlocks(plan: PlanResult): [number, number][] {
  const out: [number, number][] = [];
  plan.stints.forEach((s, j) => {
    if (j === 0 || s.tyreChange === 4) out.push([j, j]);
    else out[out.length - 1][1] = j;
  });
  return out;
}

export function blockIndex(blocks: [number, number][], j: number): number {
  return blocks.findIndex(([from, to]) => j >= from && j <= to);
}

/** Assigns drivers (equal driving time, one driver per tyre block) then spotters. Locked assignments are kept. */
export function assignCrew(inp: StrategyInputs, plan: PlanResult): StintAssignment[] {
  const S = plan.stints.length;
  const drivers = inp.drivers;
  const ids = drivers.map((d) => d.id);
  const prev = Array.from({ length: S }, (_, j) => {
    const a = inp.assignments[j] ?? emptyAssignment();
    return {
      ...a,
      driverId: a.driverId && ids.includes(a.driverId) ? a.driverId : null,
      spotterId: a.spotterId && ids.includes(a.spotterId) ? a.spotterId : null,
    };
  });
  if (!drivers.length) return prev.map(() => emptyAssignment());

  const avail = availabilityMatrix(inp, plan);
  const ctx: Ctx = { inp, plan, avail, targets: driveTargets(inp, plan, avail) };
  // Drivers only change when tyres are changed: one driver per tyre block.
  const blocks = tyreBlocks(plan);
  const B = blocks.length;
  const lockedBlock = blocks.map(([from, to]) => {
    for (let j = from; j <= to; j++) if (prev[j].driverLocked && prev[j].driverId) return ids.indexOf(prev[j].driverId!);
    return -1;
  });
  const locked = lockedBlock.map((d) => d >= 0);
  const blk = lockedBlock.slice();
  const drv = new Array<number>(S).fill(-1);
  const expand = () => blocks.forEach(([from, to], b) => drv.fill(blk[b], from, to + 1));

  // greedy: give each block to the driver that brings the crew closest to the targets
  for (let b = 0; b < B; b++) {
    if (locked[b]) continue;
    let best = -1;
    let bestCost = Infinity;
    for (let d = 0; d < drivers.length; d++) {
      blk[b] = d;
      expand();
      const tentative = cost(ctx, drv);
      if (tentative < bestCost) {
        bestCost = tentative;
        best = d;
      }
    }
    blk[b] = best;
  }
  expand();

  // local search: single moves and swaps until no improvement
  const tryCost = () => {
    expand();
    return cost(ctx, drv);
  };
  let current = tryCost();
  for (let pass = 0; pass < 50; pass++) {
    let improved = false;
    for (let b = 0; b < B; b++) {
      if (locked[b]) continue;
      for (let d = 0; d < drivers.length; d++) {
        if (d === blk[b]) continue;
        const old = blk[b];
        blk[b] = d;
        const c = tryCost();
        if (c < current - 1e-9) {
          current = c;
          improved = true;
        } else blk[b] = old;
      }
    }
    for (let b = 0; b < B; b++) {
      if (locked[b]) continue;
      for (let k = b + 1; k < B; k++) {
        if (locked[k] || blk[b] === blk[k]) continue;
        [blk[b], blk[k]] = [blk[k], blk[b]];
        const c = tryCost();
        if (c < current - 1e-9) {
          current = c;
          improved = true;
        } else [blk[b], blk[k]] = [blk[k], blk[b]];
      }
    }
    if (!improved) break;
  }
  expand();

  // spotters: least time on duty, prefer the next driver then the previous one
  const duty = new Array(drivers.length).fill(0);
  drv.forEach((d, j) => d >= 0 && (duty[d] += plan.stints[j].driveSec));
  const spot = prev.map((a) => (a.spotterLocked && a.spotterId ? ids.indexOf(a.spotterId) : -1));
  spot.forEach((s, j) => s >= 0 && (duty[s] += plan.stints[j].driveSec));
  for (let j = 0; j < S; j++) {
    if (prev[j].spotterLocked && spot[j] >= 0) continue;
    let best = -1;
    let bestScore = Infinity;
    for (let d = 0; d < drivers.length; d++) {
      if (d === drv[j] || !drivers[d].canSpot || avail[j][d] === 'unavailable') continue;
      let score = duty[d];
      if (drv[j + 1] === d) score -= 1800;
      else if (drv[j - 1] === d) score -= 900;
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    spot[j] = best;
    if (best >= 0) duty[best] += plan.stints[j].driveSec;
  }

  return prev.map((a, j) => ({
    driverId: drv[j] >= 0 ? ids[drv[j]] : null,
    spotterId: spot[j] >= 0 ? ids[spot[j]] : null,
    driverLocked: locked[blockIndex(blocks, j)],
    spotterLocked: a.spotterLocked && spot[j] >= 0,
  }));
}

export interface CrewTotals {
  driverId: string;
  driveSec: number;
  spotSec: number;
  stints: number;
  targetSec: number;
}

export function crewTotals(inp: StrategyInputs, plan: PlanResult): CrewTotals[] {
  const avail = availabilityMatrix(inp, plan);
  const targets = driveTargets(inp, plan, avail);
  return inp.drivers.map((d, i) => {
    const t: CrewTotals = { driverId: d.id, driveSec: 0, spotSec: 0, stints: 0, targetSec: targets[i] };
    plan.stints.forEach((s, j) => {
      const a = inp.assignments[j];
      if (a?.driverId === d.id) {
        t.driveSec += s.driveSec;
        t.stints++;
      }
      if (a?.spotterId === d.id) t.spotSec += s.driveSec;
    });
    return t;
  });
}

/** Human-readable rule violations of the current crew assignment. */
export function crewIssues(inp: StrategyInputs, plan: PlanResult): string[] {
  const issues: string[] = [];
  const avail = availabilityMatrix(inp, plan);
  const byId = new Map(inp.drivers.map((d, i) => [d.id, i]));
  plan.stints.forEach((s, j) => {
    const a = inp.assignments[j];
    if (!a?.driverId) {
      issues.push(`Stint ${j + 1}: no driver.`);
      return;
    }
    const i = byId.get(a.driverId)!;
    if (avail[j][i] === 'unavailable') issues.push(`Stint ${j + 1}: ${inp.drivers[i].name} is unavailable.`);
    if (j > 0 && s.tyreChange !== 4 && inp.assignments[j - 1]?.driverId !== a.driverId)
      issues.push(`Stint ${j + 1}: driver change without a 4-tyre change.`);
    if (a.spotterId && a.spotterId === a.driverId) issues.push(`Stint ${j + 1}: driver and spotter are the same person.`);
    if (a.spotterId) {
      const si = byId.get(a.spotterId)!;
      if (avail[j][si] === 'unavailable') issues.push(`Stint ${j + 1}: spotter ${inp.drivers[si].name} is unavailable.`);
    }
  });
  inp.drivers.forEach((d) => {
    let run = 0;
    let lastEnd = -Infinity;
    plan.stints.forEach((s, j) => {
      const mine = inp.assignments[j]?.driverId === d.id;
      if (mine) {
        const prevMine = j > 0 && inp.assignments[j - 1]?.driverId === d.id;
        if (!prevMine && d.minRestMin > 0 && s.startSec - lastEnd < d.minRestMin * 60)
          issues.push(`Stint ${j + 1}: ${d.name} has less than ${d.minRestMin} min rest.`);
        run = prevMine ? run + 1 : 1;
        if (d.maxConsecutiveStints > 0 && run === d.maxConsecutiveStints + 1)
          issues.push(`Stint ${j + 1}: ${d.name} exceeds ${d.maxConsecutiveStints} stints in a row.`);
        lastEnd = s.endSec;
      }
    });
  });
  for (const t of crewTotals(inp, plan)) {
    const d = inp.drivers.find((x) => x.id === t.driverId)!;
    if (d.maxDriveMin != null && t.driveSec > d.maxDriveMin * 60) issues.push(`${d.name} drives more than the maximum.`);
    if (d.minDriveMin != null && t.driveSec < d.minDriveMin * 60) issues.push(`${d.name} drives less than the minimum.`);
  }
  return issues;
}
