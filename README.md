# LMU Strategy Maker

Web app to build race strategies for Le Mans Ultimate: stint plan, pit stops, tyres and crew (drivers + spotters).

## Features

- Race setup: category (Hypercar / LMP2 / LMGT3), timed or fixed-laps race, real start time, pit times, VE/fuel use, lap times dry/wet, tyres available per compound, weather windows.
- Strategy engine (`src/app/core/engine/strategy.ts`): finds the plan with the most laps, choosing at each stop between no tyres, 2 tyres (one side) or 4 tyres, and the compound, against the time lost on worn tyres. Refuels only what the next stint needs.
- Crew (`src/app/core/engine/assign.ts`): equal driving time, availability, max/min driving time, max stints in a row, min rest. Drivers only change at 4-tyre stops.
- Manual overrides per stint (laps, tyre action, compound), manual driver/spotter picks (locked), per-stint availability.
- Every calculation is saved as a version; versions can be compared and restored.

## Development

```bash
npm install
npm start        # http://localhost:4200
npm test         # engine tests (Vitest)
npm run build
```
