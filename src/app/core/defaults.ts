import { Category, Driver, StrategyInputs, StintOverride, TyreCompound } from './models';
import { toLocalInput, uid } from './util';

export const DRIVER_COLORS = ['#e4572e', '#29a8ab', '#f3a712', '#7b61ff', '#3fb950', '#ff6ec7', '#4aa3ff', '#c9b458'];

export function newDriver(index: number): Driver {
  return {
    id: uid(),
    name: `Driver ${index + 1}`,
    color: DRIVER_COLORS[index % DRIVER_COLORS.length],
    canSpot: true,
    minDriveMin: null,
    maxDriveMin: null,
    maxConsecutiveStints: 3,
    minRestMin: 0,
    availability: [],
  };
}

export function newTyre(partial: Partial<TyreCompound> = {}): TyreCompound {
  return {
    id: uid(),
    name: 'Medium',
    weather: 'dry',
    tyres: 16,
    wearPctPerLap: 2.5,
    degSecPerLap: 0.05,
    paceOffsetSec: 0,
    ...partial,
  };
}

export const CATEGORIES: { id: Category; name: string }[] = [
  { id: 'hypercar', name: 'Hypercar' },
  { id: 'lmp2', name: 'LMP2' },
  { id: 'gt3', name: 'LMGT3' },
];

/** Default values per compound. Only Hypercars have Soft and Hard. */
const COMPOUND_PRESETS: Record<string, Partial<TyreCompound>> = {
  Soft: { name: 'Soft', tyres: 8, wearPctPerLap: 3.5, degSecPerLap: 0.08, paceOffsetSec: -0.4 },
  Medium: { name: 'Medium', tyres: 24, wearPctPerLap: 2.5, degSecPerLap: 0.05, paceOffsetSec: 0 },
  Hard: { name: 'Hard', tyres: 16, wearPctPerLap: 1.8, degSecPerLap: 0.035, paceOffsetSec: 0.4 },
  Wet: { name: 'Wet', weather: 'wet', tyres: 16, wearPctPerLap: 2, degSecPerLap: 0.04, paceOffsetSec: 0 },
};

export const CATEGORY_COMPOUNDS: Record<Category, string[]> = {
  hypercar: ['Soft', 'Medium', 'Hard', 'Wet'],
  lmp2: ['Medium', 'Wet'],
  gt3: ['Medium', 'Wet'],
};

/** Compounds allowed in the category. Values already entered for a compound are kept. */
export function tyresForCategory(category: Category, existing: TyreCompound[] = []): TyreCompound[] {
  return CATEGORY_COMPOUNDS[category].map(
    (name) => existing.find((t) => t.name === name) ?? newTyre(COMPOUND_PRESETS[name]),
  );
}

export function emptyOverride(): StintOverride {
  return { lockedLaps: null, tyreAction: 'auto', compoundId: null };
}

/** Example values for an LMU Hypercar 6h race. Every value can be edited. */
export function defaultInputs(): StrategyInputs {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(14, 0, 0, 0);
  return {
    race: {
      category: 'hypercar',
      mode: 'time',
      durationMin: 360,
      laps: 160,
      startTime: toLocalInput(start.getTime()),
      pitLaneLossSec: 26,
      driverChangeSec: 10,
      refuelSecPerPct: 0.35,
      tyreChange4Sec: 13,
      tyreChange2Sec: 6,
      serviceParallel: true,
      veMarginPct: 1,
      startVePct: 100,
      mismatchPenaltySec: 10,
      cliffPenaltySec: 2,
      weather: [],
    },
    car: {
      vePerLapDry: 7.3,
      vePerLapWet: 6.4,
      lapTimeDrySec: 125.5,
      lapTimeWetSec: 141,
    },
    tyres: tyresForCategory('hypercar'),
    drivers: [newDriver(0), newDriver(1), newDriver(2)],
    overrides: [],
    assignments: [],
  };
}
