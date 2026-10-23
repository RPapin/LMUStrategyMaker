export type Category = 'hypercar' | 'lmp2' | 'gt3';
export type TeamRole = 'owner' | 'editor' | 'driver';
export type Weather = 'dry' | 'wet';
/** Tyres changed at a stop: none, one side (2) or all four. */
export type TyreChange = 0 | 2 | 4;
export type TyreAction = 'auto' | 'four' | 'two' | 'keep';
export type Availability = 'available' | 'preferred' | 'unavailable';

/** Weather window expressed in race minutes from the start. */
export interface WeatherWindow {
  id: string;
  fromMin: number;
  toMin: number;
  weather: Weather;
}

export interface RaceSettings {
  /** Decides which tyre compounds are available. */
  category: Category;
  mode: 'time' | 'laps';
  durationMin: number;
  laps: number;
  /** Local date-time of the race start, `YYYY-MM-DDTHH:mm`. */
  startTime: string;
  pitLaneLossSec: number;
  driverChangeSec: number;
  /** Seconds needed to add 1% of virtual energy. */
  refuelSecPerPct: number;
  tyreChange4Sec: number;
  tyreChange2Sec: number;
  /** True when refuel, tyre change and driver swap happen at the same time. */
  serviceParallel: boolean;
  veMarginPct: number;
  startVePct: number;
  /** Seconds lost per lap when running a tyre that does not match the weather. */
  mismatchPenaltySec: number;
  /** Extra seconds per lap, per lap run beyond the tyre's life. */
  cliffPenaltySec: number;
  weather: WeatherWindow[];
}

export interface CarSettings {
  vePerLapDry: number;
  vePerLapWet: number;
  lapTimeDrySec: number;
  lapTimeWetSec: number;
}

export interface TyreCompound {
  id: string;
  name: string;
  weather: Weather;
  /** Individual tyres available (4 per full change, 2 per side). */
  tyres: number;
  wearPctPerLap: number;
  /** Seconds lost per lap of tyre age. */
  degSecPerLap: number;
  /** Pace difference against the base lap time (negative = faster). */
  paceOffsetSec: number;
}

/** Availability window in real time (epoch ms). Anything not covered is "available". */
export interface AvailabilityWindow {
  from: number;
  to: number;
  status: Exclude<Availability, 'available'>;
}

export interface Driver {
  id: string;
  name: string;
  color: string;
  canSpot: boolean;
  minDriveMin: number | null;
  maxDriveMin: number | null;
  maxConsecutiveStints: number;
  minRestMin: number;
  availability: AvailabilityWindow[];
}

export interface StintOverride {
  lockedLaps: number | null;
  tyreAction: TyreAction;
  compoundId: string | null;
}

export interface StintAssignment {
  driverId: string | null;
  spotterId: string | null;
  driverLocked: boolean;
  spotterLocked: boolean;
}

export interface StrategyInputs {
  race: RaceSettings;
  car: CarSettings;
  tyres: TyreCompound[];
  drivers: Driver[];
  /** Indexed by stint. */
  overrides: (StintOverride | null)[];
  /** Indexed by stint. */
  assignments: StintAssignment[];
}

export interface PitStop {
  laneSec: number;
  refuelPct: number;
  refuelSec: number;
  tyreCount: TyreChange;
  tyreSec: number;
  driverChange: boolean;
  driverSec: number;
  serviceSec: number;
  totalSec: number;
}

export interface Stint {
  index: number;
  startLap: number;
  endLap: number;
  laps: number;
  wetLaps: number;
  weather: Weather;
  /** Race clock in seconds. */
  startSec: number;
  endSec: number;
  driveSec: number;
  avgLapSec: number;
  compoundId: string;
  compoundName: string;
  /** Tyres fitted at the start of this stint (4 for the first stint). */
  tyreChange: TyreChange;
  /** Laps already done by each pair at the start of the stint (older side, newer side). */
  tyreAgeOld: number;
  tyreAgeNew: number;
  /** Wear of the older side at the end of the stint. */
  tyreWearEndPct: number;
  veStartPct: number;
  veUsedPct: number;
  veEndPct: number;
  /** Stop made at the end of this stint, null for the last one. */
  stop: PitStop | null;
}

export interface PlanResult {
  totalLaps: number;
  totalSec: number;
  stops: number;
  stints: Stint[];
  /** Individual tyres used per compound. */
  tyresUsed: Partial<Record<string, number>>;
  warnings: string[];
  computedAt: string;
}

export interface StrategyVersion {
  id: string;
  number: number;
  createdAt: string;
  label: string;
  note: string;
  inputs: StrategyInputs;
  plan: PlanResult | null;
}

export interface StrategyRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  draft: StrategyInputs;
  plan: PlanResult | null;
  /** Version the draft/plan currently derives from. */
  baseVersion: number | null;
  /** True when the draft changed since the plan was last calculated. */
  dirty: boolean;
  versions: StrategyVersion[];
  /** Set for strategies stored in a Supabase team, absent for local ones. */
  teamId?: string | null;
}
